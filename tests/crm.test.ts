import { afterAll, describe, expect, it } from "vitest";
import { canTransition, CRM_STAGES, isCrmStage, type CrmStageName } from "@/lib/crm";
import {
  dueFollowUps,
  followUpDay,
  InvalidTransitionError,
  LeadNotFoundError,
  leadUpdateSchema,
  markOutreachSent,
  OutreachNotFoundError,
  parseFollowUpDay,
  updateLead,
} from "@/lib/leads";
import { createTestDb } from "./helpers/db";

describe("canTransition", () => {
  it("allows staying where you are", () => {
    for (const stage of CRM_STAGES) expect(canTransition(stage, stage)).toBe(true);
  });

  it("allows moving forward, including skipping stages", () => {
    expect(canTransition("NEW", "QUALIFIED")).toBe(true);
    expect(canTransition("NEW", "CONTACTED")).toBe(true);
    expect(canTransition("NEW", "RETAINED")).toBe(true);
    expect(canTransition("CONTACTED", "CONVERTED")).toBe(true);
    expect(canTransition("DELIVERED", "RETAINED")).toBe(true);
  });

  it("allows a single step back to fix a mistake", () => {
    expect(canTransition("CONTACTED", "QUALIFIED")).toBe(true);
    expect(canTransition("REPLIED", "CONTACTED")).toBe(true);
    expect(canTransition("RETAINED", "DELIVERED")).toBe(true);
  });

  it("rejects moving back more than one stage", () => {
    expect(canTransition("CONTACTED", "NEW")).toBe(false);
    expect(canTransition("CONVERTED", "QUALIFIED")).toBe(false);
    expect(canTransition("RETAINED", "NEW")).toBe(false);
  });

  it("allows any lead to be marked dead", () => {
    for (const stage of CRM_STAGES) expect(canTransition(stage, "DEAD")).toBe(true);
  });

  it("only revives a dead lead to the start of the pipeline", () => {
    expect(canTransition("DEAD", "NEW")).toBe(true);
    expect(canTransition("DEAD", "QUALIFIED")).toBe(true);
    for (const stage of ["CONTACTED", "REPLIED", "CONVERTED", "DELIVERED", "RETAINED"] as CrmStageName[]) {
      expect(canTransition("DEAD", stage)).toBe(false);
    }
  });
});

describe("isCrmStage", () => {
  it("accepts the known stages and nothing else", () => {
    expect(CRM_STAGES.every(isCrmStage)).toBe(true);
    for (const value of ["new", "", "WON", null, undefined, 3, {}]) expect(isCrmStage(value)).toBe(false);
  });
});

describe("leadUpdateSchema", () => {
  it("accepts a stage, notes, or both", () => {
    expect(leadUpdateSchema.safeParse({ crmStage: "CONTACTED" }).success).toBe(true);
    expect(leadUpdateSchema.safeParse({ notes: "hello" }).success).toBe(true);
    expect(leadUpdateSchema.safeParse({ notes: null }).success).toBe(true);
    expect(leadUpdateSchema.safeParse({ crmStage: "NEW", notes: "" }).success).toBe(true);
  });

  it.each([
    ["an empty update", {}],
    ["an unknown stage", { crmStage: "WON" }],
    ["a lower-case stage", { crmStage: "contacted" }],
    ["non-string notes", { notes: 5 }],
    ["notes that are too long", { notes: "x".repeat(10_001) }],
  ])("rejects %s", (_name, body) => {
    expect(leadUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe("updateLead", () => {
  const db = createTestDb();
  const { prisma } = db;
  afterAll(() => db.cleanup());

  async function newLead(crmStage: CrmStageName = "NEW") {
    const campaign = await prisma.campaign.create({ data: { name: "c", region: "r", niche: "n" } });
    return prisma.business.create({
      data: { campaignId: campaign.id, name: "Clinic", dedupeKey: `ref:${Math.random()}`, crmStage },
    });
  }
  const history = (businessId: string) =>
    prisma.stageChange.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });

  it("moves the stage and records the change", async () => {
    const lead = await newLead();
    const updated = await updateLead(prisma, lead.id, { crmStage: "CONTACTED" });
    expect(updated.crmStage).toBe("CONTACTED");
    expect(await history(lead.id)).toEqual([expect.objectContaining({ fromStage: "NEW", toStage: "CONTACTED" })]);
  });

  it("builds up an ordered history across several moves", async () => {
    const lead = await newLead();
    await updateLead(prisma, lead.id, { crmStage: "QUALIFIED" });
    await updateLead(prisma, lead.id, { crmStage: "CONTACTED" });
    await updateLead(prisma, lead.id, { crmStage: "DEAD" });
    await updateLead(prisma, lead.id, { crmStage: "NEW" });
    const moves = (await history(lead.id)).map((h) => `${h.fromStage}>${h.toStage}`);
    expect(moves).toEqual(["NEW>QUALIFIED", "QUALIFIED>CONTACTED", "CONTACTED>DEAD", "DEAD>NEW"]);
  });

  it("rejects an invalid move without changing the lead or its history", async () => {
    const lead = await newLead("CONTACTED");
    await expect(updateLead(prisma, lead.id, { crmStage: "NEW" })).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: lead.id } })).crmStage).toBe("CONTACTED");
    expect(await history(lead.id)).toEqual([]);
  });

  it("does not apply notes from a request whose stage change is rejected", async () => {
    const lead = await newLead("CONTACTED");
    await expect(updateLead(prisma, lead.id, { crmStage: "NEW", notes: "sneaky" })).rejects.toThrow();
    expect((await prisma.business.findUniqueOrThrow({ where: { id: lead.id } })).notes).toBeNull();
  });

  it("saves notes without recording a stage change", async () => {
    const lead = await newLead();
    const updated = await updateLead(prisma, lead.id, { notes: "call on Monday" });
    expect(updated).toMatchObject({ notes: "call on Monday", crmStage: "NEW" });
    expect(await history(lead.id)).toEqual([]);
  });

  it("clears notes with null", async () => {
    const lead = await newLead();
    await updateLead(prisma, lead.id, { notes: "something" });
    expect((await updateLead(prisma, lead.id, { notes: null })).notes).toBeNull();
  });

  it("does not record a change when the stage is unchanged", async () => {
    const lead = await newLead("REPLIED");
    await updateLead(prisma, lead.id, { crmStage: "REPLIED", notes: "n" });
    expect(await history(lead.id)).toEqual([]);
  });

  it("reports an unknown lead", async () => {
    await expect(updateLead(prisma, "nope", { crmStage: "NEW" })).rejects.toBeInstanceOf(LeadNotFoundError);
  });

  it("keeps outreach drafts when the stage moves", async () => {
    const lead = await newLead();
    await prisma.outreach.create({ data: { businessId: lead.id, subject: "s", openLine: "o", body: "b" } });
    await updateLead(prisma, lead.id, { crmStage: "CONTACTED" });
    expect(await prisma.outreach.count({ where: { businessId: lead.id } })).toBe(1);
  });
});

describe("follow-up days", () => {
  it("reads a calendar day as UTC midnight, and back", () => {
    const date = parseFollowUpDay("2026-10-17");
    expect(date?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(followUpDay(date!)).toBe("2026-10-17");
  });

  it.each(["2026-02-30", "2026-13-01", "17/10/2026", "2026-10-17T10:00:00Z", ""])("rejects %j", (day) => {
    expect(parseFollowUpDay(day)).toBeNull();
  });

  it("is accepted, or cleared with null, by a lead update", () => {
    const parsed = leadUpdateSchema.parse({ followUpAt: "2026-10-17" });
    expect(parsed.followUpAt?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(leadUpdateSchema.parse({ followUpAt: null }).followUpAt).toBeNull();
    expect(leadUpdateSchema.safeParse({ followUpAt: "next week" }).success).toBe(false);
  });
});

describe("markOutreachSent and dueFollowUps", () => {
  const db = createTestDb();
  const { prisma } = db;
  afterAll(() => db.cleanup());

  async function leadWithDraft(data: { crmStage?: CrmStageName; followUpAt?: Date } = {}) {
    const campaign = await prisma.campaign.create({ data: { name: "c", region: "r", niche: "n" } });
    const lead = await prisma.business.create({
      data: { campaignId: campaign.id, name: "Clinic", dedupeKey: `ref:${Math.random()}`, ...data },
    });
    const draft = await prisma.outreach.create({ data: { businessId: lead.id, subject: "s", openLine: "o", body: "b" } });
    return { lead, draft, campaign };
  }
  const NOW = new Date("2026-10-14T15:30:00.000Z");

  it("records the send, moves a new lead to CONTACTED, and plans a follow-up three days on", async () => {
    const { lead, draft } = await leadWithDraft();
    const { outreach, business } = await markOutreachSent(prisma, draft.id, { now: NOW });
    expect(outreach.sentAt).toEqual(NOW);
    expect(business.crmStage).toBe("CONTACTED");
    expect(followUpDay(business.followUpAt!)).toBe("2026-10-17");
    const changes = await prisma.stageChange.findMany({ where: { businessId: lead.id } });
    expect(changes).toEqual([expect.objectContaining({ fromStage: "NEW", toStage: "CONTACTED" })]);
  });

  it("leaves a lead that is further along, and a follow-up already planned, as they are", async () => {
    const planned = parseFollowUpDay("2026-10-20")!;
    const { lead, draft } = await leadWithDraft({ crmStage: "REPLIED", followUpAt: planned });
    const { business } = await markOutreachSent(prisma, draft.id, { now: NOW });
    expect(business).toMatchObject({ crmStage: "REPLIED", followUpAt: planned });
    expect(await prisma.stageChange.count({ where: { businessId: lead.id } })).toBe(0);
  });

  it("replaces a follow-up date that has come due, since this send is the follow-up", async () => {
    // Otherwise a lead followed up on would read "due" for good.
    const { draft } = await leadWithDraft({ crmStage: "CONTACTED", followUpAt: parseFollowUpDay("2026-10-14")! });
    const { business } = await markOutreachSent(prisma, draft.id, { now: NOW });
    expect(followUpDay(business.followUpAt!)).toBe("2026-10-17");
    const overdue = await leadWithDraft({ crmStage: "CONTACTED", followUpAt: parseFollowUpDay("2026-10-01")! });
    expect(followUpDay((await markOutreachSent(prisma, overdue.draft.id, { now: NOW })).business.followUpAt!)).toBe("2026-10-17");
  });

  it("keeps the first send time when a draft is marked sent twice", async () => {
    const { draft } = await leadWithDraft();
    await markOutreachSent(prisma, draft.id, { now: NOW });
    const { outreach } = await markOutreachSent(prisma, draft.id, { now: new Date("2026-10-20T09:00:00.000Z") });
    expect(outreach.sentAt).toEqual(NOW);
  });

  it("reports an unknown draft", async () => {
    await expect(markOutreachSent(prisma, "nope")).rejects.toBeInstanceOf(OutreachNotFoundError);
  });

  it("lists follow-ups due on or before a day, oldest first, leaving dead leads out", async () => {
    const day = (d: string) => parseFollowUpDay(d)!;
    const { campaign } = await leadWithDraft();
    const make = (name: string, followUpAt: Date | null, crmStage: CrmStageName = "CONTACTED") =>
      prisma.business.create({ data: { campaignId: campaign.id, name, dedupeKey: name, followUpAt, crmStage } });
    await make("due today", day("2026-10-14"));
    await make("overdue", day("2026-10-10"));
    await make("tomorrow", day("2026-10-15"));
    await make("dead", day("2026-10-01"), "DEAD");
    await make("nothing planned", null);

    const due = (await dueFollowUps(prisma, day("2026-10-14"))).filter((b) => b.campaign.id === campaign.id);
    expect(due.map((b) => b.name)).toEqual(["overdue", "due today"]);
  });
});

describe("markOutreachSent: races and days", () => {
  const db = createTestDb();
  const { prisma } = db;
  afterAll(() => db.cleanup());

  async function draftOnNewLead() {
    const campaign = await prisma.campaign.create({ data: { name: "c", region: "r", niche: "n" } });
    const lead = await prisma.business.create({ data: { campaignId: campaign.id, name: "L", dedupeKey: `k${Math.random()}` } });
    return prisma.outreach.create({ data: { businessId: lead.id, subject: "s", openLine: "o", body: "b" } });
  }

  it("records one send and one stage move when marked twice at once", async () => {
    const draft = await draftOnNewLead();
    await Promise.all([markOutreachSent(prisma, draft.id), markOutreachSent(prisma, draft.id)]);
    expect(await prisma.stageChange.count({ where: { businessId: draft.businessId } })).toBe(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: draft.businessId } })).crmStage).toBe("CONTACTED");
  });

  it("plans the follow-up from the user's day when given", async () => {
    const draft = await draftOnNewLead();
    // 23:00 UTC on the 14th is already the 15th in Tirana.
    const { business } = await markOutreachSent(prisma, draft.id, { now: new Date("2026-10-14T23:00:00Z"), today: "2026-10-15" });
    expect(followUpDay(business.followUpAt!)).toBe("2026-10-18");
  });

  it("rejects a year no one meant, as a date input produces while the year is typed", () => {
    expect(parseFollowUpDay("0202-10-17")).toBeNull();
    expect(parseFollowUpDay("2027-10-17")).not.toBeNull();
  });
});

describe("markOutreachSent: the history row's starting stage", () => {
  const db = createTestDb();
  const { prisma } = db;
  afterAll(() => db.cleanup());

  it("records QUALIFIED -> CONTACTED for a qualified lead", async () => {
    const campaign = await prisma.campaign.create({ data: { name: "c", region: "r", niche: "n" } });
    const lead = await prisma.business.create({
      data: { campaignId: campaign.id, name: "L", dedupeKey: "q1", crmStage: "QUALIFIED" },
    });
    const draft = await prisma.outreach.create({ data: { businessId: lead.id, subject: "s", openLine: "o", body: "b" } });
    await markOutreachSent(prisma, draft.id);
    const rows = await prisma.stageChange.findMany({ where: { businessId: lead.id } });
    expect(rows).toEqual([expect.objectContaining({ fromStage: "QUALIFIED", toStage: "CONTACTED" })]);
  });
});

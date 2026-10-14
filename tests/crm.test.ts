import { afterAll, describe, expect, it } from "vitest";
import { canTransition, CRM_STAGES, isCrmStage, type CrmStageName } from "@/lib/crm";
import { InvalidTransitionError, LeadNotFoundError, leadUpdateSchema, updateLead } from "@/lib/leads";
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

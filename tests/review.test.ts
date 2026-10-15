import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { whatsappLink } from "@/lib/contacts";
import { DraftAlreadySentError, draftEditSchema, DraftNotFoundError, editDraft, reviewQueue } from "@/lib/review";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

let campaignId: string;
beforeEach(async () => {
  campaignId = (await prisma.campaign.create({ data: { name: "c", region: "Tirana", niche: "dentist" } })).id;
});

const NO_WEBSITE = { key: "no_website", label: "No website found", severity: 40 };
async function lead(name: string, data: Record<string, unknown> = {}, drafts: { sentAt?: Date; body?: string }[] = []) {
  return prisma.business.create({
    data: {
      campaignId,
      name,
      dedupeKey: name,
      phone: "+355 69 1",
      signals: { create: [NO_WEBSITE] },
      outreach: { create: drafts.map((d) => ({ subject: "s", openLine: "o", body: d.body ?? "b", sentAt: d.sentAt })) },
      ...data,
    },
  });
}

describe("reviewQueue", () => {
  it("puts each lead where its next step is", async () => {
    await lead("unsent draft", { score: 50 }, [{}]);
    await lead("sent", { crmStage: "CONTACTED" }, [{ sentAt: new Date("2026-10-10") }]);
    await lead("needs a draft", { score: 40 });
    await lead("nothing verified", { signals: { create: [{ ...NO_WEBSITE, certainty: "UNCERTAIN" }] } });
    await lead("unreachable", { phone: null });
    await lead("dead", { crmStage: "DEAD" }, [{}]);
    await lead("already contacted, no draft", { crmStage: "CONTACTED" });

    const q = await reviewQueue(prisma, campaignId);
    expect(q.ready.map((c) => c.name)).toEqual(["unsent draft"]);
    expect(q.needsDraft.map((c) => c.name)).toEqual(["needs a draft"]);
    expect(q.sent.map((c) => c.name)).toEqual(["sent"]);
    expect(q.ready[0]).toMatchObject({ topGap: "No website found", draft: { body: "b", fromTemplate: false, sentAt: null } });
  });

  it("judges a lead by its latest draft, and lists the most recently sent first", async () => {
    // An old sent draft and a newer unsent one: the newer one is the next step.
    await lead("resend", {}, [{ sentAt: new Date("2026-10-01"), body: "first" }]);
    const r = await prisma.business.findFirstOrThrow({ where: { campaignId, name: "resend" } });
    await prisma.outreach.create({ data: { businessId: r.id, subject: "s", openLine: "o", body: "second", createdAt: new Date(Date.now() + 1000) } });
    await lead("older", {}, [{ sentAt: new Date("2026-10-02") }]);
    await lead("newer", {}, [{ sentAt: new Date("2026-10-05") }]);

    const q = await reviewQueue(prisma, campaignId);
    expect(q.ready.map((c) => [c.name, c.draft?.body])).toEqual([["resend", "second"]]);
    expect(q.sent.map((c) => c.name)).toEqual(["newer", "older"]);
  });
});

describe("editDraft", () => {
  it("saves edits to an unsent draft, first line as its open line", async () => {
    const { id } = await lead("A", {}, [{}]);
    const draft = await prisma.outreach.findFirstOrThrow({ where: { businessId: id } });
    const saved = await editDraft(prisma, draft.id, draftEditSchema.parse({ subject: "New", body: "Hello\nthere" }));
    expect(saved).toMatchObject({ subject: "New", body: "Hello\nthere", openLine: "Hello" });
  });

  it("keeps a sent draft as it went out", async () => {
    const { id } = await lead("A", {}, [{ sentAt: new Date() }]);
    const draft = await prisma.outreach.findFirstOrThrow({ where: { businessId: id } });
    await expect(editDraft(prisma, draft.id, { subject: null, body: "changed" })).rejects.toBeInstanceOf(DraftAlreadySentError);
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } })).body).toBe("b");
  });

  it("reports an unknown draft, and refuses an empty message", async () => {
    await expect(editDraft(prisma, "nope", { subject: null, body: "x" })).rejects.toBeInstanceOf(DraftNotFoundError);
    expect(draftEditSchema.safeParse({ body: "  " }).success).toBe(false);
  });
});

describe("whatsappLink", () => {
  it("links an international number, digits only", () => {
    expect(whatsappLink("+355 69 123 4567")).toBe("https://wa.me/355691234567");
  });

  it("doesn't guess a country code for a local number", () => {
    expect(whatsappLink("069 123 4567")).toBeUndefined();
    expect(whatsappLink(null)).toBeUndefined();
  });
});

describe("reviewQueue: drafts overtaken by the web check", () => {
  it("flags an unsent draft written before a site was found", async () => {
    const { id } = await lead("Found later", {}, [{}]);
    await prisma.business.update({ where: { id }, data: { onlineCheck: "found", onlineCheckedAt: new Date(Date.now() + 1000) } });
    const q = await reviewQueue(prisma, campaignId);
    expect(q.ready.find((c) => c.leadId === id)?.draft?.outdated).toBe(true);
  });
});

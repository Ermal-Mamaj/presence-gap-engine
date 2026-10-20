import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmStageName } from "@/lib/crm";
import { BulkDraftInProgressError, draftForLead, draftTopLeads, MAX_BULK_DRAFTS } from "@/lib/drafting";
import { OutreachError, type OutreachDeps } from "@/lib/outreach";
import { createTestDb } from "./helpers/db";

// These cover the path where the model writes the draft; templates are tests/templates.test.ts.
process.env.DRAFT_SOURCE = "claude";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

const DRAFT = JSON.stringify({ open_line: "o", subject: "s", body: "b" });
type CreateMessage = NonNullable<OutreachDeps["createMessage"]>;
const ok = () => vi.fn<CreateMessage>(async () => ({ content: [{ type: "text", text: DRAFT }], stop_reason: "end_turn" }));

let campaignId: string;
beforeEach(async () => {
  campaignId = (
    await prisma.campaign.create({ data: { name: "Dentists", region: "Tirana", niche: "dentist", language: "sq" } })
  ).id;
});

type Gap = { key: string; severity: number; certainty?: string };
const NO_WEBSITE: Gap = { key: "no_website", severity: 40 };

async function lead(name: string, score: number, opts: { stage?: CrmStageName; gaps?: Gap[]; email?: string; drafted?: boolean } = {}) {
  return prisma.business.create({
    data: {
      campaignId,
      name,
      dedupeKey: name,
      score,
      email: opts.email,
      crmStage: opts.stage ?? "NEW",
      signals: { create: (opts.gaps ?? [NO_WEBSITE]).map((g) => ({ ...g, label: g.key })) },
      ...(opts.drafted ? { outreach: { create: [{ subject: "old", openLine: "o", body: "b" }] } } : {}),
    },
  });
}

describe("draftTopLeads", () => {
  it("drafts only leads ready for a first message, best score first", async () => {
    await lead("best", 60);
    await lead("second", 50);
    await lead("already drafted", 90, { drafted: true });
    await lead("already contacted", 80, { stage: "CONTACTED" });
    await lead("nothing verified to say", 70, { gaps: [{ key: "site_unreachable", severity: 35, certainty: "UNCERTAIN" }] });
    await lead("no gap", 0, { gaps: [] });

    const createMessage = ok();
    const outcome = await draftTopLeads(prisma, campaignId, { deps: { createMessage } });

    expect(outcome).toEqual({ selected: 2, drafted: 2, failed: [] });
    const drafted = await prisma.business.findMany({
      where: { campaignId, outreach: { some: { subject: "s" } } },
      orderBy: { score: "desc" },
    });
    expect(drafted.map((b) => b.name)).toEqual(["best", "second"]);
  });

  it("writes in the campaign's language and on a channel the lead can be reached on", async () => {
    const reachable = await lead("by email", 50, { email: "a@b.al" });
    const createMessage = ok();
    await draftTopLeads(prisma, campaignId, { deps: { createMessage } });
    expect(createMessage.mock.calls[0][0]).toContain("Albanian");
    const saved = await prisma.outreach.findFirstOrThrow({ where: { businessId: reachable.id } });
    expect(saved.channel).toBe("email");
  });

  it("respects the limit, and never drafts more than the cap", async () => {
    for (let i = 0; i < 4; i++) await lead(`lead ${i}`, 40 + i);
    expect((await draftTopLeads(prisma, campaignId, { limit: 3, deps: { createMessage: ok() } })).drafted).toBe(3);
    // Asking for more than the cap is clamped, not refused.
    const outcome = await draftTopLeads(prisma, campaignId, { limit: MAX_BULK_DRAFTS + 100, deps: { createMessage: ok() } });
    expect(outcome.selected).toBe(1);
  });

  it("reports a lead whose draft fails and carries on with the rest", async () => {
    await lead("fine", 60);
    await lead("bad answer", 50);
    let calls = 0;
    const createMessage = vi.fn<CreateMessage>(async () => {
      calls++;
      return { content: [{ type: "text", text: calls === 2 ? "not json" : DRAFT }], stop_reason: "end_turn" };
    });
    const outcome = await draftTopLeads(prisma, campaignId, { deps: { createMessage } });
    expect(outcome.drafted).toBe(1);
    expect(outcome.failed).toEqual([expect.objectContaining({ error: "The model did not return valid JSON" })]);
  });

  it("stops at the first credentials failure instead of repeating it for every lead", async () => {
    for (let i = 0; i < 6; i++) await lead(`lead ${i}`, 40 + i);
    const createMessage = vi.fn<CreateMessage>(async () => {
      throw new OutreachError("not_configured", "No usable Claude credentials.");
    });
    const outcome = await draftTopLeads(prisma, campaignId, { deps: { createMessage } });
    expect(outcome).toMatchObject({ selected: 6, drafted: 0, failed: [], stoppedBecause: "No usable Claude credentials." });
    // The three already in flight when it failed, no more.
    expect(createMessage.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("draftForLead", () => {
  it("uses the channel asked for, and records it", async () => {
    const { id } = await lead("phone me", 50, { email: "a@b.al" });
    const target = await prisma.business.findUniqueOrThrow({ where: { id }, include: { signals: true, campaign: true } });
    const createMessage = ok();
    const saved = await draftForLead(prisma, target, { channel: "phone", deps: { createMessage } });
    expect(saved.channel).toBe("phone");
    expect(createMessage.mock.calls[0][0]).toContain("phone call");
  });
});

describe("draftTopLeads: one run per campaign at a time", () => {
  it("refuses a second run while the first is still drafting, and allows one after", async () => {
    await lead("slow", 60);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const createMessage = vi.fn<CreateMessage>(async () => {
      await gate;
      return { content: [{ type: "text", text: DRAFT }], stop_reason: "end_turn" };
    });
    const first = draftTopLeads(prisma, campaignId, { deps: { createMessage } });
    await expect(draftTopLeads(prisma, campaignId, { deps: { createMessage } })).rejects.toBeInstanceOf(
      BulkDraftInProgressError
    );
    release();
    expect((await first).drafted).toBe(1);
    // Finished, so the next run may start; nothing is left to draft.
    expect(await draftTopLeads(prisma, campaignId, { deps: { createMessage } })).toMatchObject({ selected: 0 });
  });
});

describe("draftForLead: a follow-up", () => {
  it("needs something already sent, and is written from a template even when the model writes first messages", async () => {
    const { id } = await lead("Klinika", 50);
    const full = await prisma.business.findUniqueOrThrow({ where: { id }, include: { signals: true, campaign: true } });
    await expect(draftForLead(prisma, full, { followUp: true })).rejects.toMatchObject({ kind: "nothing_sent" });

    await prisma.outreach.create({ data: { businessId: id, subject: "s", openLine: "o", body: "first", sentAt: new Date() } });
    await prisma.messageTemplate.create({
      data: { language: "sq", channel: "email", gapKey: "follow_up", subject: "Përsëri", body: "Përshëndetje përsëri {{name}}" },
    });
    const draft = await draftForLead(prisma, full, { followUp: true, channel: "email" });
    expect(draft).toMatchObject({ body: "Përshëndetje përsëri Klinika", sentAt: null });
  });
});

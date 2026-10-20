import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CrmStageName } from "@/lib/crm";
import { outreachStats } from "@/lib/stats";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

let campaignId: string;
let templateA: string;
let templateB: string;
beforeEach(async () => {
  await prisma.outreach.deleteMany();
  await prisma.business.deleteMany();
  await prisma.messageTemplate.deleteMany();
  campaignId = (await prisma.campaign.create({ data: { name: "c", region: "Tirana", niche: "Dentist" } })).id;
  const t = (body: string, channel = "message") =>
    prisma.messageTemplate.create({ data: { language: "sq", channel, gapKey: "no_website", body } });
  templateA = (await t("Përshëndetje A, a keni faqe interneti?")).id;
  templateB = (await t("Përshëndetje B")).id;
});

async function lead(
  stage: CrmStageName,
  drafts: { templateId?: string | null; channel?: string; sentAt?: Date | null }[],
  options: { moves?: [CrmStageName, CrmStageName][]; campaign?: string } = {}
) {
  const created = await prisma.business.create({
    data: {
      campaignId: options.campaign ?? campaignId,
      name: `lead${Math.random()}`,
      dedupeKey: `k${Math.random()}`,
      crmStage: stage,
      stageChanges: { create: (options.moves ?? []).map(([fromStage, toStage], i) => ({ fromStage, toStage, createdAt: new Date(Date.now() + i) })) },
    },
  });
  for (const [i, d] of drafts.entries()) {
    await prisma.outreach.create({
      data: {
        businessId: created.id,
        channel: d.channel ?? "message",
        templateId: d.templateId ?? null,
        subject: "s",
        openLine: "o",
        body: "b",
        sentAt: d.sentAt === undefined ? new Date(Date.now() - (10 - i) * 1000) : d.sentAt,
      },
    });
  }
  return created;
}

describe("outreachStats", () => {
  it("counts replies by the template of the first message, best first", async () => {
    await lead("REPLIED", [{ templateId: templateA }]);
    await lead("CONTACTED", [{ templateId: templateA }]);
    await lead("CONTACTED", [{ templateId: templateB }]);
    await lead("CONTACTED", [{ templateId: templateB }]);
    await lead("CONTACTED", [{ templateId: templateB }]);

    const stats = await outreachStats(prisma);
    expect(stats.sent).toBe(5);
    expect(stats.byTemplate.map((t) => [t.templateId, t.sent, t.replied, t.replyRate])).toEqual([
      [templateA, 2, 1, 0.5],
      [templateB, 3, 0, 0],
    ]);
    expect(stats.byTemplate[0].label).toContain("Përshëndetje A");
  });

  it("counts a reply that was followed by 'not interested', and a client as a reply too", async () => {
    await lead("DEAD", [{ templateId: templateA }], { moves: [["CONTACTED", "REPLIED"], ["REPLIED", "DEAD"]] });
    await lead("CONVERTED", [{ templateId: templateA }]);
    await lead("DEAD", [{ templateId: templateA }], { moves: [["CONTACTED", "DEAD"]] });

    const [a] = (await outreachStats(prisma)).byTemplate;
    expect(a).toMatchObject({ sent: 3, replied: 2, converted: 1 });
  });

  it("counts a reply stepped straight back as a mis-click, not a reply", async () => {
    await lead("CONTACTED", [{ templateId: templateA }], { moves: [["CONTACTED", "REPLIED"], ["REPLIED", "CONTACTED"]] });
    expect((await outreachStats(prisma)).byTemplate[0]).toMatchObject({ sent: 1, replied: 0 });
  });

  it("counts a lead once, under its first message, and ignores drafts never sent", async () => {
    await lead("REPLIED", [{ templateId: templateA }, { templateId: templateB }]); // first message, then a follow-up
    await lead("CONTACTED", [{ templateId: templateB, sentAt: null }]); // written, not sent
    const stats = await outreachStats(prisma);
    expect(stats.sent).toBe(1);
    expect(stats.byTemplate).toHaveLength(1);
    expect(stats.byTemplate[0]).toMatchObject({ templateId: templateA, replied: 1 });
  });

  it("groups messages without a template, or whose template was deleted", async () => {
    await lead("REPLIED", [{ templateId: null }]);
    const deleted = await prisma.messageTemplate.create({ data: { language: "sq", channel: "message", gapKey: "no_website", body: "gone" } });
    await lead("CONTACTED", [{ templateId: deleted.id }]);
    await prisma.messageTemplate.delete({ where: { id: deleted.id } });
    const stats = await outreachStats(prisma);
    expect(stats.byTemplate).toHaveLength(1);
    expect(stats.byTemplate[0]).toMatchObject({ templateId: null, sent: 2, replied: 1 });
    expect(stats.byTemplate[0].label).toMatch(/No template/);
  });

  it("splits by channel and by business type, and by campaign when asked", async () => {
    await lead("REPLIED", [{ channel: "message" }]);
    await lead("CONTACTED", [{ channel: "email" }]);
    const other = (await prisma.campaign.create({ data: { name: "o", region: "Tirana", niche: "restaurant" } })).id;
    await lead("CONTACTED", [{ channel: "message" }], { campaign: other });

    const all = await outreachStats(prisma);
    expect(all.byChannel.map((c) => [c.channel, c.sent, c.replied])).toEqual([
      ["message", 2, 1],
      ["email", 1, 0],
    ]);
    expect(all.byNiche.map((n) => [n.niche, n.sent, n.replied])).toEqual([
      ["dentist", 2, 1],
      ["restaurant", 1, 0],
    ]);

    const one = await outreachStats(prisma, campaignId);
    expect(one.sent).toBe(2);
    expect(one.byNiche).toHaveLength(1);
  });

  it("is empty with nothing sent", async () => {
    await lead("NEW", [{ sentAt: null }]);
    expect(await outreachStats(prisma)).toEqual({ sent: 0, byTemplate: [], byChannel: [], byNiche: [] });
  });
});

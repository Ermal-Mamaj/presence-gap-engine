import { afterAll, describe, expect, it } from "vitest";
import type { CrmStageName } from "@/lib/crm";
import { pipelineSummary } from "@/lib/pipeline";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

async function campaignWith(leads: { stage: CrmStageName; history?: CrmStageName[] }[]) {
  const campaign = await prisma.campaign.create({ data: { name: "c", region: "r", niche: "n" } });
  for (const [i, lead] of leads.entries()) {
    const path: CrmStageName[] = ["NEW", ...(lead.history ?? [])];
    await prisma.business.create({
      data: {
        campaignId: campaign.id,
        name: `lead ${i}`,
        dedupeKey: `k${i}`,
        crmStage: lead.stage,
        stageChanges: { create: path.slice(1).map((toStage, j) => ({ fromStage: path[j], toStage })) },
      },
    });
  }
  return campaign.id;
}

const reachedOf = (summary: Awaited<ReturnType<typeof pipelineSummary>>) =>
  Object.fromEntries(summary.reached.map((r) => [r.stage, r.count]));

describe("pipelineSummary", () => {
  it("counts how far each lead got, including leads that later died", async () => {
    const id = await campaignWith([
      { stage: "NEW" },
      { stage: "CONTACTED", history: ["CONTACTED"] },
      { stage: "DEAD", history: ["CONTACTED", "REPLIED", "DEAD"] },
      { stage: "CONVERTED", history: ["CONTACTED", "REPLIED", "CONVERTED"] },
      { stage: "DEAD", history: ["DEAD"] },
    ]);
    const summary = await pipelineSummary(prisma, id);

    expect(summary).toMatchObject({ total: 5, dead: 2 });
    expect(reachedOf(summary)).toEqual({
      NEW: 5,
      QUALIFIED: 3,
      CONTACTED: 3,
      REPLIED: 2,
      CONVERTED: 1,
      DELIVERED: 0,
      RETAINED: 0,
    });
    // 2 of 3 contacted replied; 1 of 2 replies converted.
    expect(summary.replyRate).toBeCloseTo(2 / 3);
    expect(summary.conversionRate).toBe(0.5);
  });

  it("counts a skipped stage as passed: going straight to CONTACTED means qualified too", async () => {
    const id = await campaignWith([{ stage: "CONTACTED", history: ["CONTACTED"] }]);
    expect(reachedOf(await pipelineSummary(prisma, id)).QUALIFIED).toBe(1);
  });

  it("has no rates before anyone is contacted", async () => {
    const id = await campaignWith([{ stage: "NEW" }]);
    expect(await pipelineSummary(prisma, id)).toMatchObject({ total: 1, replyRate: null, conversionRate: null });
  });

  it("covers every campaign when none is named", async () => {
    const all = await pipelineSummary(prisma);
    expect(all.total).toBeGreaterThanOrEqual(7);
  });
});

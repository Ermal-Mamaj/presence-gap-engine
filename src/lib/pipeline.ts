import type { PrismaClient } from "@/generated/prisma/client";
import { PIPELINE, type CrmStageName } from "./crm";

export interface PipelineSummary {
  total: number;
  dead: number;
  /** How many leads got at least this far, in pipeline order. */
  reached: { stage: CrmStageName; count: number }[];
  /** Share of contacted leads that replied, and of replies that converted; null with nothing to divide by. */
  replyRate: number | null;
  conversionRate: number | null;
}

/**
 * How far leads got, across all campaigns or one. "Reached" uses the furthest
 * stage in each lead's history, not only where it is now: a lead that
 * replied and then died was still contacted, and counting current stages
 * would hide that. A move that was stepped straight back (the one-step undo
 * crm.ts allows for a mis-click) does not count as reached.
 */
export async function pipelineSummary(prisma: PrismaClient, campaignId?: string): Promise<PipelineSummary> {
  const leads = await prisma.business.findMany({
    where: campaignId ? { campaignId } : {},
    select: {
      crmStage: true,
      stageChanges: { select: { fromStage: true, toStage: true }, orderBy: { createdAt: "asc" } },
    },
  });

  const furthest = leads.map((lead) => {
    const changes = lead.stageChanges;
    const kept = changes.filter((change, i) => {
      const next = changes[i + 1];
      const undone =
        next !== undefined &&
        next.fromStage === change.toStage &&
        PIPELINE.indexOf(next.toStage) === PIPELINE.indexOf(change.toStage) - 1;
      return !undone;
    });
    const stages = [lead.crmStage, ...kept.map((c) => c.toStage)];
    return Math.max(0, ...stages.map((s) => PIPELINE.indexOf(s)));
  });
  const reached = PIPELINE.map((stage, i) => ({ stage, count: furthest.filter((f) => f >= i).length }));
  const count = (stage: CrmStageName) => reached.find((r) => r.stage === stage)!.count;
  const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);

  return {
    total: leads.length,
    dead: leads.filter((l) => l.crmStage === "DEAD").length,
    reached,
    replyRate: rate(count("REPLIED"), count("CONTACTED")),
    conversionRate: rate(count("CONVERTED"), count("REPLIED")),
  };
}

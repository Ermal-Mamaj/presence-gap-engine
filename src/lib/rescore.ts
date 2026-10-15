import type { PrismaClient } from "@/generated/prisma/client";
import { fromStoredSignal } from "./detect";
import { CampaignNotFoundError } from "./scan";
import { computeScore } from "./score";

export interface RescoreOutcome {
  /** Leads whose score was recomputed. */
  rescored: number;
  /** Of those, how many came out different. */
  changed: number;
}

/**
 * Recomputes every lead's score from what is already stored, its gap signals
 * and listing fields, without fetching anything.
 *
 * A score is written at scan time, so changing a weight in score.ts used to
 * leave every existing lead on its old number until a full rescan, which also
 * re-checks every website. Nothing but the score is written: signals, stage,
 * notes and drafts are untouched.
 */
export async function rescoreCampaign(prisma: PrismaClient, campaignId: string): Promise<RescoreOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
      if (!campaign) throw new CampaignNotFoundError();

      const leads = await tx.business.findMany({ where: { campaignId }, include: { signals: true } });
      let changed = 0;
      for (const lead of leads) {
        const score = computeScore(lead.signals.map(fromStoredSignal), lead);
        if (score === lead.score) continue;
        await tx.business.update({ where: { id: lead.id }, data: { score } });
        changed++;
      }
      return { rescored: leads.length, changed };
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}

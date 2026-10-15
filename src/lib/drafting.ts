import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { fromStoredSignal } from "./detect";
import { draftOutreach, OutreachError, type OutreachDeps } from "./outreach";
import { defaultChannel, DEFAULT_LANGUAGE, type DraftChannel, isDraftLanguage } from "./outreachOptions";
import { mapWithConcurrency } from "./scan";

type LeadForDraft = Prisma.BusinessGetPayload<{ include: { signals: true; campaign: true } }>;

/**
 * Drafts and stores one outreach message for a lead, in its campaign's
 * language, for the given channel or else one the lead can be reached on.
 * Shared by the single-draft route and bulk drafting, so both write the same
 * thing.
 */
export async function draftForLead(
  prisma: PrismaClient,
  lead: LeadForDraft,
  options: { channel?: DraftChannel; deps?: OutreachDeps } = {}
) {
  const channel = options.channel ?? defaultChannel(lead);
  const language = isDraftLanguage(lead.campaign.language) ? lead.campaign.language : DEFAULT_LANGUAGE;
  const draft = await draftOutreach(
    {
      name: lead.name,
      address: lead.address,
      website: lead.website,
      rating: lead.rating,
      reviewCount: lead.reviewCount,
    },
    lead.signals.map(fromStoredSignal),
    options.deps ?? {},
    { channel, language }
  );
  return prisma.outreach.create({
    data: { businessId: lead.id, channel, subject: draft.subject, openLine: draft.openLine, body: draft.body },
  });
}

export const MAX_BULK_DRAFTS = 20;
const BULK_CONCURRENCY = 3;

export interface BulkDraftOutcome {
  /** Leads that met the criteria, best first. */
  selected: number;
  drafted: number;
  failed: { leadId: string; name: string; error: string }[];
  /** Set when drafting stopped early because no call could succeed (missing credentials). */
  stoppedBecause?: string;
}

/**
 * Drafts the best leads in a campaign that are ready for a first message:
 * a verified gap to mention, no draft yet, and not yet contacted. Highest
 * score first, at most MAX_BULK_DRAFTS, three at a time.
 *
 * One lead's failure doesn't stop the rest, except a credentials failure,
 * which every remaining call would repeat.
 */
export async function draftTopLeads(
  prisma: PrismaClient,
  campaignId: string,
  options: { limit?: number; deps?: OutreachDeps } = {}
): Promise<BulkDraftOutcome> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 10)), MAX_BULK_DRAFTS);
  const leads = await prisma.business.findMany({
    where: {
      campaignId,
      crmStage: { in: ["NEW", "QUALIFIED"] },
      outreach: { none: {} },
      // The same rule as citableSignals: only a verified, scoring gap may be stated.
      signals: { some: { certainty: { not: "UNCERTAIN" }, severity: { gt: 0 } } },
    },
    include: { signals: true, campaign: true },
    orderBy: { score: "desc" },
    take: limit,
  });

  const outcome: BulkDraftOutcome = { selected: leads.length, drafted: 0, failed: [] };
  await mapWithConcurrency(leads, BULK_CONCURRENCY, async (lead) => {
    if (outcome.stoppedBecause) return;
    try {
      await draftForLead(prisma, lead, { deps: options.deps });
      outcome.drafted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Draft generation failed";
      if (err instanceof OutreachError && err.kind === "not_configured") {
        outcome.stoppedBecause ??= message;
        return;
      }
      outcome.failed.push({ leadId: lead.id, name: lead.name, error: message });
    }
  });
  return outcome;
}

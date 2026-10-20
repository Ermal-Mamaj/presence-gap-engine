import type { PrismaClient } from "@/generated/prisma/client";
import { fromStoredSignal } from "./detect";
import { draftOutreach, OutreachError, type OutreachDeps } from "./outreach";
import { defaultChannel, DEFAULT_LANGUAGE, type DraftChannel, isDraftLanguage } from "./outreachOptions";
import { mapWithConcurrency } from "./scan";
import { draftFromTemplate, type LeadForDraft } from "./templates";

export type DraftSource = "templates" | "claude";

/**
 * Where draft text comes from. Templates, written by a person and filled in
 * by code, unless DRAFT_SOURCE=claude asks for the model to write it.
 */
export function draftSource(): DraftSource {
  return process.env.DRAFT_SOURCE?.trim().toLowerCase() === "claude" ? "claude" : "templates";
}

/**
 * Drafts and stores one outreach message for a lead, in its campaign's
 * language, for the given channel or else one the lead can be reached on.
 * Shared by the single-draft route and bulk drafting, so both write the same
 * thing.
 */
export async function draftForLead(
  prisma: PrismaClient,
  lead: LeadForDraft,
  options: { channel?: DraftChannel; deps?: OutreachDeps; source?: DraftSource; followUp?: boolean } = {}
) {
  const channel = options.channel ?? defaultChannel(lead);
  if (options.followUp && (await prisma.outreach.count({ where: { businessId: lead.id, sentAt: { not: null } } })) === 0) {
    throw new OutreachError("nothing_sent", "Nothing has been sent to this lead yet, so there is nothing to follow up.");
  }
  // A follow-up is always written from a template, whatever writes first messages.
  if (options.followUp || (options.source ?? draftSource()) === "templates") {
    const draft = await draftFromTemplate(prisma, lead, channel, { followUp: options.followUp });
    return prisma.outreach.create({
      data: {
        businessId: lead.id,
        channel,
        templateId: draft.templateId,
        subject: draft.subject,
        // A template has no separate open line; its first line serves.
        openLine: draft.body.split("\n")[0].trim(),
        body: draft.body,
      },
    });
  }
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
async function draftTopLeadsNow(
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
  // Templates are filled in memory, and rotate by how often each was used: three at once would
  // all read the same counts and pick the same template. Only the Claude API gains from concurrency.
  const concurrency = draftSource() === "claude" ? BULK_CONCURRENCY : 1;
  await mapWithConcurrency(leads, concurrency, async (lead) => {
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

/** Another bulk run for the same campaign is still drafting. */
export class BulkDraftInProgressError extends Error {
  constructor() {
    super("Drafting for this campaign is already running. Wait for it to finish.");
    this.name = "BulkDraftInProgressError";
  }
}

// Campaigns with a bulk run in progress, for the whole process (on globalThis,
// like the Prisma client, so a dev reload can't start a second set).
const globalForBulk = globalThis as unknown as { bulkDraftRuns?: Set<string> };
const runningBulk = () => (globalForBulk.bulkDraftRuns ??= new Set<string>());

/**
 * Drafts the best leads in a campaign that are ready for a first message (see
 * draftTopLeadsNow), one run per campaign at a time. Without this, a second
 * tab or a retry after a slow response would pick the same undrafted leads
 * and draft each twice, at twice the cost.
 */
export async function draftTopLeads(
  prisma: PrismaClient,
  campaignId: string,
  options: { limit?: number; deps?: OutreachDeps } = {}
): Promise<BulkDraftOutcome> {
  const running = runningBulk();
  if (running.has(campaignId)) throw new BulkDraftInProgressError();
  running.add(campaignId);
  try {
    return await draftTopLeadsNow(prisma, campaignId, options);
  } finally {
    running.delete(campaignId);
  }
}

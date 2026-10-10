import type { Business, Prisma, PrismaClient } from "@/generated/prisma/client";
import { dedupeKeyFor } from "./dedupe";
import { analyzePresence, type DetectableBusiness, type PresenceAnalysis } from "./detect";
import { computeScore } from "./score";
import type { BusinessSource, RawBusiness } from "./sources/types";
import { sanitizeRawBusiness } from "./sources/validate";

/** The campaign already has a scan in progress. */
export class ScanConflictError extends Error {
  constructor() {
    super("A scan is already running for this campaign");
    this.name = "ScanConflictError";
  }
}

export class CampaignNotFoundError extends Error {
  constructor() {
    super("Campaign not found");
    this.name = "CampaignNotFoundError";
  }
}

/** The source failed or returned nothing usable; nothing was saved. */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export interface ScanDeps {
  /** Resolves the campaign's source id (e.g. "OSM") to an adapter. */
  getSource: (sourceId: string) => BusinessSource;
  analyze?: (business: DetectableBusiness) => Promise<PresenceAnalysis>;
  concurrency?: number;
  /** A RUNNING campaign untouched for this long is treated as crashed. */
  staleAfterMs?: number;
  now?: () => Date;
}

export interface ScanOutcome {
  scanId: string;
  found: number;
  created: number;
  updated: number;
  skipped: number;
}

const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface PreparedLead {
  dedupeKey: string;
  data: Omit<Prisma.BusinessUncheckedCreateInput, "campaignId" | "dedupeKey">;
  analysis: PresenceAnalysis;
}

/**
 * Re-scanning refreshes what the source reports, but never replaces a known
 * value with "unknown": a thinner fetch shouldn't erase a phone number.
 */
function mergeWithExisting(raw: RawBusiness, existing: Business | undefined) {
  return {
    name: raw.name,
    address: raw.address ?? existing?.address ?? undefined,
    phone: raw.phone ?? existing?.phone ?? undefined,
    website: raw.website ?? existing?.website ?? undefined,
    latitude: raw.latitude ?? existing?.latitude ?? undefined,
    longitude: raw.longitude ?? existing?.longitude ?? undefined,
    rating: raw.rating ?? existing?.rating ?? undefined,
    reviewCount: raw.reviewCount ?? existing?.reviewCount ?? undefined,
    sourceRef: raw.sourceRef ?? existing?.sourceRef ?? undefined,
  };
}

/**
 * Runs discovery for a campaign without ever putting saved leads at risk.
 *
 * 1. Claim the campaign atomically; a second concurrent run is refused.
 * 2. Discover, validate and analyze everything in memory. If any of this
 *    fails, nothing has been written except the failed ScanRun record.
 * 3. Apply the results in one transaction that only creates or updates leads.
 *    Leads are never deleted, and CRM stage, notes and outreach are never
 *    touched, so a rerun can't destroy work already done on a lead.
 */
export async function runCampaignScan(
  prisma: PrismaClient,
  campaignId: string,
  deps: ScanDeps
): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date());
  const analyze = deps.analyze ?? ((b: DetectableBusiness) => analyzePresence(b));

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignNotFoundError();

  // Single atomic statement: of two simultaneous requests exactly one matches.
  const staleCutoff = new Date(now().getTime() - (deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));
  const claim = await prisma.campaign.updateMany({
    where: { id: campaignId, OR: [{ status: { not: "RUNNING" } }, { updatedAt: { lt: staleCutoff } }] },
    data: { status: "RUNNING", errorMessage: null },
  });
  if (claim.count === 0) throw new ScanConflictError();

  // Anything still marked RUNNING belongs to a run that crashed or was killed.
  await prisma.scanRun.updateMany({
    where: { campaignId, status: "RUNNING" },
    data: { status: "FAILED", errorMessage: "Interrupted before it finished", finishedAt: now() },
  });
  const scan = await prisma.scanRun.create({ data: { campaignId, startedAt: now() } });

  try {
    let rawResults: unknown;
    try {
      rawResults = await deps.getSource(campaign.source).search({ region: campaign.region, niche: campaign.niche });
    } catch (err) {
      throw new DiscoveryError(err instanceof Error ? err.message : "Discovery failed");
    }
    if (!Array.isArray(rawResults)) throw new DiscoveryError("Source returned an unexpected response");

    let skipped = 0;
    const unique = new Map<string, RawBusiness>();
    for (const item of rawResults) {
      const raw = sanitizeRawBusiness(item);
      if (!raw) {
        skipped++;
        continue;
      }
      const key = dedupeKeyFor(raw);
      if (unique.has(key)) {
        skipped++;
        continue;
      }
      unique.set(key, raw);
    }
    if (rawResults.length > 0 && unique.size === 0) {
      throw new DiscoveryError(`Source returned ${rawResults.length} records but none were usable`);
    }

    const existingRows = await prisma.business.findMany({ where: { campaignId } });
    const existingByKey = new Map(existingRows.map((row) => [row.dedupeKey, row]));

    const prepared = await mapWithConcurrency(
      [...unique.entries()],
      deps.concurrency ?? DEFAULT_CONCURRENCY,
      async ([dedupeKey, raw]): Promise<PreparedLead> => {
        const merged = mergeWithExisting(raw, existingByKey.get(dedupeKey));
        const analysis = await analyze(merged);
        const score = computeScore(analysis.signals, merged);
        return {
          dedupeKey,
          analysis,
          data: { ...merged, score, websiteStatus: analysis.websiteStatus, lastSeenAt: now() },
        };
      }
    );

    let created = 0;
    let updated = 0;
    await prisma.$transaction(async (tx) => {
      for (const lead of prepared) {
        const existing = existingByKey.get(lead.dedupeKey);
        const business = await tx.business.upsert({
          where: { campaignId_dedupeKey: { campaignId, dedupeKey: lead.dedupeKey } },
          create: { ...lead.data, campaignId, dedupeKey: lead.dedupeKey },
          update: lead.data,
        });
        if (existing) {
          updated++;
          await tx.gapSignal.deleteMany({ where: { businessId: business.id } });
        } else {
          created++;
        }
        if (lead.analysis.signals.length) {
          await tx.gapSignal.createMany({
            data: lead.analysis.signals.map((s) => ({
              businessId: business.id,
              key: s.key,
              label: s.label,
              severity: s.severity,
              certainty: s.certainty,
              detail: s.detail,
            })),
          });
        }
      }
      await tx.scanRun.update({
        where: { id: scan.id },
        data: { status: "SUCCEEDED", found: prepared.length, created, updated, skipped, finishedAt: now() },
      });
      await tx.campaign.update({ where: { id: campaignId }, data: { status: "DONE", errorMessage: null } });
    }, TRANSACTION_OPTIONS);

    return { scanId: scan.id, found: prepared.length, created, updated, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // The transaction (if it started) has rolled back, so earlier leads are
    // intact. Record the failure; if even this write fails, the stale-run
    // check above will recover the campaign on the next attempt.
    try {
      await prisma.scanRun.update({
        where: { id: scan.id },
        data: { status: "FAILED", errorMessage: message, finishedAt: now() },
      });
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "FAILED", errorMessage: message } });
    } catch (recordError) {
      console.error("Could not record scan failure", recordError);
    }
    throw err;
  }
}

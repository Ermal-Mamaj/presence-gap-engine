import type { Business, GapSignal, Prisma, PrismaClient } from "@/generated/prisma/client";
import type { SiteContacts } from "./contacts";
import { dedupeKeyFor } from "./dedupe";
import {
  analyzePresence,
  deferWebsiteCheck,
  fromStoredSignal,
  websiteNeedsFetch,
  type DetectableBusiness,
  type PresenceAnalysis,
} from "./detect";
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
  /**
   * Most websites one scan fetches. Leads past it are still saved; their
   * websites wait for a later scan, which takes the least recently checked first.
   */
  maxWebsiteChecks?: number;
  now?: () => Date;
}

export interface ScanOutcome {
  scanId: string;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  /** Websites over the check limit, left for a later scan. */
  deferred: number;
}

const DEFAULT_CONCURRENCY = 5;
/**
 * Bounds scan time, not lead count. A check can take 8s per URL candidate with
 * one retry, while a lead without a website costs no request at all, so only
 * the websites are capped.
 */
export const DEFAULT_MAX_WEBSITE_CHECKS = 60;
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
  /** The website was not fetched and its earlier assessment stands, signals included. */
  keepSignals: boolean;
}

type ExistingLead = Business & { signals: GapSignal[] };

/** Whether the stored assessment is of the website the lead has now. */
function hasCurrentCheck(existing: ExistingLead | undefined, website: string | undefined): existing is ExistingLead {
  return Boolean(existing?.siteCheckedAt) && existing?.website === website;
}

/**
 * Picks the websites this scan fetches. Sites never checked (new leads, or a
 * website that changed) go first, then the least recently checked, so a
 * campaign with more sites than the limit is covered over successive scans
 * instead of the same ones being re-checked every time.
 */
function selectWebsiteChecks(
  candidates: { dedupeKey: string; website?: string; existing?: ExistingLead }[],
  limit: number
): Set<string> {
  const lastChecked = (c: (typeof candidates)[number]) =>
    hasCurrentCheck(c.existing, c.website) ? c.existing.siteCheckedAt!.getTime() : -Infinity;
  // Array.prototype.sort is stable, so ties keep the source's order.
  const ordered = [...candidates].sort((a, b) => lastChecked(a) - lastChecked(b));
  return new Set(ordered.slice(0, Math.max(0, limit)).map((c) => c.dedupeKey));
}

/**
 * Re-scanning refreshes what the source reports, but never replaces a known
 * value with "unknown": a thinner fetch shouldn't erase a phone number.
 *
 * For phone and email the listing comes first, then whatever the business's
 * own site publishes, then anything remembered from an earlier scan.
 */
function mergeWithExisting(raw: RawBusiness, existing: Business | undefined, site: SiteContacts = {}) {
  return {
    name: raw.name,
    address: raw.address ?? existing?.address ?? undefined,
    phone: raw.phone ?? site.phone ?? existing?.phone ?? undefined,
    email: raw.email ?? site.email ?? existing?.email ?? undefined,
    facebook: raw.facebook ?? existing?.facebook ?? undefined,
    instagram: raw.instagram ?? existing?.instagram ?? undefined,
    website: raw.website ?? existing?.website ?? undefined,
    latitude: raw.latitude ?? existing?.latitude ?? undefined,
    longitude: raw.longitude ?? existing?.longitude ?? undefined,
    rating: raw.rating ?? existing?.rating ?? undefined,
    reviewCount: raw.reviewCount ?? existing?.reviewCount ?? undefined,
    sourceRef: raw.sourceRef ?? existing?.sourceRef ?? undefined,
  };
}

/** A campaign claimed for scanning, and the ScanRun recording the attempt. */
export interface ScanClaim {
  scanId: string;
  campaignId: string;
  source: string;
  region: string;
  niche: string;
}

/**
 * Claims a campaign for scanning and opens its ScanRun.
 *
 * Split from the scan body so a caller can answer the client before the work
 * starts: everything that decides the HTTP status — the campaign exists, no
 * other scan holds it — happens here, so 404 and 409 are still immediate and
 * correct while the scan itself runs afterwards.
 */
export async function claimCampaignScan(
  prisma: PrismaClient,
  campaignId: string,
  deps: Pick<ScanDeps, "staleAfterMs" | "now"> = {}
): Promise<ScanClaim> {
  const now = deps.now ?? (() => new Date());

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignNotFoundError();

  // Single atomic statement: of two simultaneous requests exactly one matches.
  //
  // Prisma stores SQLite DateTime as ISO-8601 TEXT, and SQLite compares storage
  // class before value, so an integer updatedAt written by raw SQL sorts below
  // every TEXT cutoff and makes the campaign look permanently stale. Write it
  // through Prisma, as the scan's heartbeat does.
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

  return {
    scanId: scan.id,
    campaignId,
    source: campaign.source,
    region: campaign.region,
    niche: campaign.niche,
  };
}

/**
 * Keeps a claim fresh while its scan makes progress. Staleness is read from
 * Campaign.updatedAt, so a scan that runs past the window without refreshing
 * it would be taken over while still alive. Beats at most three times per
 * window, and only refreshes a campaign that is still RUNNING.
 */
function claimHeartbeat(prisma: PrismaClient, campaignId: string, now: () => Date, staleAfterMs: number) {
  const interval = staleAfterMs / 3;
  let last = now().getTime();
  return async () => {
    const at = now();
    if (at.getTime() - last < interval) return;
    last = at.getTime();
    try {
      await prisma.campaign.updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { updatedAt: at } });
    } catch (err) {
      // A missed beat only risks the stale rule firing early; not worth failing the scan.
      console.error("Could not refresh scan claim", err);
    }
  };
}

/**
 * Runs the claimed scan without ever putting saved leads at risk.
 *
 * 1. Discover, validate and analyze everything in memory. If any of this
 *    fails, nothing has been written except the failed ScanRun record.
 * 2. Apply the results in one transaction that only creates or updates leads.
 *    Leads are never deleted, and CRM stage, notes and outreach are never
 *    touched, so a rerun can't destroy work already done on a lead.
 *
 * Safe to call after the HTTP response has been sent: every outcome, including
 * a crash, is recorded on the ScanRun, and a campaign left RUNNING by a killed
 * process is reclaimable once it goes stale.
 */
export async function executeCampaignScan(
  prisma: PrismaClient,
  claim: ScanClaim,
  deps: ScanDeps
): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date());
  const analyze = deps.analyze ?? ((b: DetectableBusiness) => analyzePresence(b));
  const { campaignId, scanId } = claim;
  const heartbeat = claimHeartbeat(prisma, campaignId, now, deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const campaign = { source: claim.source, region: claim.region, niche: claim.niche };
  const scan = { id: scanId };

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

    const existingRows = await prisma.business.findMany({ where: { campaignId }, include: { signals: true } });
    const existingByKey = new Map(existingRows.map((row) => [row.dedupeKey, row]));

    const entries = [...unique.entries()].map(([dedupeKey, raw]) => {
      const existing = existingByKey.get(dedupeKey);
      const listing = mergeWithExisting(raw, existing);
      return { dedupeKey, raw, existing, listing, website: listing.website?.trim() || undefined };
    });
    // Only websites that cost a request count against the limit; a social
    // page or a retired site is settled from its URL.
    const withWebsite = entries.filter((e) => websiteNeedsFetch(e.website));
    const limit = deps.maxWebsiteChecks ?? DEFAULT_MAX_WEBSITE_CHECKS;
    const toCheck = selectWebsiteChecks(
      withWebsite.map((e) => ({ dedupeKey: e.dedupeKey, website: e.listing.website, existing: e.existing })),
      limit
    );
    const deferred = withWebsite.length - toCheck.size;

    const prepared = await mapWithConcurrency(
      entries,
      deps.concurrency ?? DEFAULT_CONCURRENCY,
      async ({ dedupeKey, raw, existing, listing, website }): Promise<PreparedLead> => {
        const checkNow = Boolean(website) && (toCheck.has(dedupeKey) || !websiteNeedsFetch(website));
        let analysis: PresenceAnalysis;
        let keepSignals = false;
        if (!website || checkNow) {
          analysis = await analyze(listing);
          await heartbeat();
        } else if (hasCurrentCheck(existing, listing.website)) {
          // Over the limit but checked before: that assessment stands, rather
          // than being replaced with "not checked".
          analysis = { signals: existing.signals.map(fromStoredSignal), websiteStatus: existing.websiteStatus };
          keepSignals = true;
        } else {
          analysis = deferWebsiteCheck(
            listing,
            `Over this scan's limit of ${limit} website checks. The next scan checks it first.`
          );
        }

        const merged = mergeWithExisting(raw, existing, analysis.contacts);
        return {
          dedupeKey,
          analysis,
          keepSignals,
          data: {
            ...merged,
            score: computeScore(analysis.signals, merged),
            websiteStatus: analysis.websiteStatus,
            lastSeenAt: now(),
            // Describes the current website: set when it is assessed, kept when
            // its earlier assessment stands, and cleared otherwise, including a
            // changed website whose check is deferred, so the next scan sees it
            // as never checked and takes it first.
            ...(checkNow ? { siteCheckedAt: now() } : keepSignals ? {} : { siteCheckedAt: null }),
          },
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
        if (existing) updated++;
        else created++;
        if (lead.keepSignals) continue;

        if (existing) await tx.gapSignal.deleteMany({ where: { businessId: business.id } });
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
        data: { status: "SUCCEEDED", found: prepared.length, created, updated, skipped, deferred, finishedAt: now() },
      });
      await tx.campaign.update({ where: { id: campaignId }, data: { status: "DONE", errorMessage: null } });
    }, TRANSACTION_OPTIONS);

    return { scanId: scan.id, found: prepared.length, created, updated, skipped, deferred };
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

/** Claim then run, in one call. The scan is complete when this resolves. */
export async function runCampaignScan(
  prisma: PrismaClient,
  campaignId: string,
  deps: ScanDeps
): Promise<ScanOutcome> {
  const claim = await claimCampaignScan(prisma, campaignId, deps);
  return executeCampaignScan(prisma, claim, deps);
}

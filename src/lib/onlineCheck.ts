import type { PrismaClient } from "@/generated/prisma/client";
import { deferWebsiteCheck, websiteNeedsFetch } from "./detect";
import { safeFetchPage, type FetchedPage } from "./safeFetch";
import { computeScore } from "./score";

/**
 * The second check on a lead that looks offline: a business with no website
 * on OpenStreetMap often has one. A web search suggests candidate pages, and
 * code decides, by fetching each candidate and matching the lead's phone,
 * name and street on it. A search result alone never counts.
 *
 * - found: a page matches strongly (the phone, or the name with the street or
 *   a domain made of the name). It becomes the lead's website, so the next
 *   scan checks it like any other, and "no website" is no longer claimed.
 * - none: nothing matched. The lead really looks offline.
 * - unsure: only the name matched. Flagged for a person to look at.
 */

export type Verdict = "found" | "none" | "unsure";

export interface CheckResult {
  verdict: Verdict;
  url: string | null;
  evidence: string[];
}

export interface CheckTarget {
  name: string;
  phone?: string | null;
  address?: string | null;
  niche: string;
  area: string;
}

// ---- Search providers ------------------------------------------------------

export interface SearchProvider {
  /** "groq", "tavily", or both in the order they're tried, e.g. "groq + tavily". */
  name: string;
  /** Candidate URLs for the business, best first. */
  search(target: CheckTarget): Promise<string[]>;
}

export class SearchError extends Error {
  constructor(
    message: string,
    readonly busy = false
  ) {
    super(message);
    this.name = "SearchError";
  }
}

const SEARCH_TIMEOUT_MS = 60_000;

async function postJson(url: string, key: string, body: object, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SearchError(`${label} could not be reached: ${err instanceof Error ? err.message : "network error"}`, true);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    // 429 is a rate limit; Tavily answers 432 and 433 when a plan's credits run out.
    const limited = res.status === 429 || res.status === 432 || res.status === 433 || res.status >= 500;
    throw new SearchError(`${label} error ${res.status}: ${detail}`, limited);
  }
  return res.json();
}

function query(target: CheckTarget): string {
  return `"${target.name}" ${target.niche} ${target.area}`;
}

/** Tavily's search API: a ranked list of result URLs, 1 credit per search. */
export function tavilyProvider(key: string): SearchProvider {
  return {
    name: "tavily",
    async search(target) {
      const data = (await postJson(
        "https://api.tavily.com/search",
        key,
        { query: query(target), max_results: 8, search_depth: "basic" },
        "Tavily"
      )) as { results?: { url?: unknown }[] };
      return (data.results ?? []).map((r) => r.url).filter((u): u is string => typeof u === "string");
    },
  };
}

/** Every http(s) URL in a piece of text, without trailing punctuation or citation marks. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]【】]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

/**
 * Groq's browser_search on a gpt-oss model. Groq returns the answer as prose
 * with citations rather than a list of results, so the model is asked for
 * URLs only and they are read out of the text (and out of any tool output the
 * response carries). Whatever it says, code verifies every URL afterwards.
 */
export function groqProvider(key: string): SearchProvider {
  return {
    name: "groq",
    async search(target) {
      const facts = [
        `Name: ${target.name}`,
        `Type: ${target.niche}`,
        `Area: ${target.area}`,
        target.address && `Address: ${target.address}`,
        target.phone && `Phone: ${target.phone}`,
      ].filter(Boolean);
      const data = (await postJson(
        "https://api.groq.com/openai/v1/chat/completions",
        key,
        {
          model: "openai/gpt-oss-20b",
          tools: [{ type: "browser_search" }],
          tool_choice: "required",
          reasoning_effort: "low",
          messages: [
            {
              role: "user",
              content:
                `Search the web for this business's own website.\n${facts.join("\n")}\n\n` +
                "Reply with only the URLs of pages that could be its own website, one per line, best first. " +
                "Leave out social media, maps, directories and review sites. If you find none, reply NONE.",
            },
          ],
        },
        "Groq"
      )) as { choices?: { message?: { content?: string; executed_tools?: unknown } }[] };
      const message = data.choices?.[0]?.message;
      return [...urlsIn(message?.content ?? ""), ...urlsIn(JSON.stringify(message?.executed_tools ?? ""))];
    },
  };
}

/** How long a provider that hit its limit is passed over before it is tried again. */
export const REST_AFTER_LIMIT_MS = 60_000;

/**
 * Tries the providers in order. When one hits its rate limit or runs out of
 * credits, the next takes over, and the one that hit it is passed over for a
 * minute before it is tried again; one that fails another way (a rejected
 * key) is passed over for good. If every provider is resting, the ones that
 * will recover are tried anyway. The error, if all fail, names each failure
 * and is busy if any of them was.
 */
export function fallbackProvider(providers: SearchProvider[], now: () => number = Date.now): SearchProvider {
  const restingUntil = new Map<SearchProvider, number>();
  const resting = (p: SearchProvider) => (restingUntil.get(p) ?? 0) > now();
  return {
    name: providers.map((p) => p.name).join(" + "),
    async search(target) {
      let candidates = providers.filter((p) => !resting(p));
      if (candidates.length === 0) candidates = providers.filter((p) => restingUntil.get(p) !== Infinity);
      const failures: SearchError[] = [];
      for (const p of candidates) {
        try {
          const urls = await p.search(target);
          restingUntil.delete(p);
          return urls;
        } catch (err) {
          if (!(err instanceof SearchError)) throw err;
          restingUntil.set(p, err.busy ? now() + REST_AFTER_LIMIT_MS : Infinity);
          failures.push(err);
        }
      }
      if (failures.length === 0) throw new SearchError("Every search provider failed; check the API keys in .env.");
      throw new SearchError(
        failures.map((f) => f.message).join("; "),
        failures.some((f) => f.busy)
      );
    },
  };
}

/**
 * The configured provider: Groq with GROQ_API_KEY and Tavily with
 * TAVILY_API_KEY. With both keys, Groq goes first (or Tavily, with
 * ONLINE_CHECK_PROVIDER=tavily) and the other takes over when it hits a limit.
 */
export function configuredProvider(): SearchProvider | null {
  const groq = process.env.GROQ_API_KEY?.trim();
  const tavily = process.env.TAVILY_API_KEY?.trim();
  const providers = [groq && groqProvider(groq), tavily && tavilyProvider(tavily)].filter((p): p is SearchProvider => Boolean(p));
  if (process.env.ONLINE_CHECK_PROVIDER?.trim().toLowerCase() === "tavily") providers.reverse();
  if (providers.length === 0) return null;
  return providers.length === 1 ? providers[0] : fallbackProvider(providers);
}

// ---- Matching ----------------------------------------------------------------

const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Words too common in business names to tell one business from another.
const GENERIC = new Set(
  (
    "klinika klinike klinik dentare dentar dental dentist dentistry clinic studio studioja qendra qendr center centre " +
    "dr doktor shpk sh p k the and of restorant restaurant kafe cafe bar hotel salon sallon parukeri berber farmaci " +
    "pharmacy shop dyqan market agjenci agency group grup ltd llc"
  ).split(" ")
);

/**
 * The words of a name that tell this business apart. Generic words go, and so
 * do the area's own words in any inflection (Tirana, Tiranë, Tirane): every
 * local page mentions the city, so "Dentist në Tiranë" must not match any
 * dental page in Tirana.
 */
function significantTokens(name: string, area: string): string[] {
  const areaWords = normalize(area).split(" ").filter((w) => w.length >= 4);
  const isArea = (t: string) => areaWords.some((w) => t.slice(0, 5) === w.slice(0, 5));
  return normalize(name)
    .split(" ")
    .filter((t) => t.length >= 3 && !GENERIC.has(t) && !isArea(t));
}

/** The last 8 digits, enough to match a number written with or without its country code. */
function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : null;
}

const STREET_WORDS = new Set(["rruga", "rr", "street", "str", "bulevardi", "blv", "lagjja", "lagja", "nr", "pallati"]);

function streetTokens(address: string | null | undefined, area: string): string[] {
  const skip = new Set([...STREET_WORDS, ...normalize(area).split(" ")]);
  return normalize(address ?? "")
    .split(" ")
    .filter((t) => t.length >= 4 && !skip.has(t) && !/^\d+$/.test(t));
}

/** What a page shows of the lead: each piece of evidence, in words. */
export function matchPage(target: CheckTarget, page: { url: string; html: string }): { strong: boolean; name: boolean; evidence: string[] } {
  const text = normalize(page.html.replace(/<[^>]+>/g, " "));
  const evidence: string[] = [];

  const key = phoneKey(target.phone);
  const phoneOnPage =
    key !== null &&
    [...page.html.matchAll(/\+?\d[\d\s().\-/]{6,}\d/g)].some((m) => m[0].replace(/\D/g, "").endsWith(key));
  if (phoneOnPage) evidence.push(`its phone number (${target.phone}) is on the page`);

  const tokens = significantTokens(target.name, target.area);
  const name =
    tokens.length > 0
      ? tokens.every((t) => text.includes(t))
      : normalize(target.name).length > 0 && text.includes(normalize(target.name));
  if (name) evidence.push(`its name "${target.name}" is on the page`);

  const street = streetTokens(target.address, target.area).find((t) => text.includes(t));
  if (street) evidence.push(`its street ("${street}") is on the page`);

  let host = "";
  try {
    host = new URL(page.url).hostname.replace(/[^a-z0-9]/g, "");
  } catch {}
  const domainName = tokens.find((t) => t.length >= 4 && host.includes(t.replace(/[^a-z0-9]/g, "")));
  if (domainName) evidence.push(`the domain contains its name ("${domainName}")`);

  return { strong: phoneOnPage || (name && Boolean(street || domainName)), name, evidence };
}

// Sites that list businesses rather than being one.
const NOT_OWN_SITE = [
  "google.", "goo.gl", "bing.com", "yelp.", "tripadvisor.", "foursquare.com", "booking.com", "wikipedia.org",
  "wikimapia.org", "mapcarta.com", "waze.com", "apple.com", "linkedin.com", "twitter.com", "x.com", "youtube.com",
  "cylex", "yellowpages", "opendi", "infobel", "kompass", "hotfrog", "zoomaal", "openstreetmap.org",
];

/** Whether a search result could be the business's own site. */
export function couldBeOwnSite(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!websiteNeedsFetch(url)) return false; // social pages, retired Google sites
  return !NOT_OWN_SITE.some((d) => host.includes(d));
}

const MAX_CANDIDATES = 5;

export interface CheckDeps {
  provider: SearchProvider;
  fetchPage?: (url: URL) => Promise<FetchedPage>;
}

/** Searches for the lead's own site and verifies each candidate page. */
export async function checkLeadOnline(target: CheckTarget, deps: CheckDeps): Promise<CheckResult> {
  const fetchPage = deps.fetchPage ?? ((url: URL) => safeFetchPage(url));
  const candidates = [...new Set((await deps.provider.search(target)).filter(couldBeOwnSite))].slice(0, MAX_CANDIDATES);

  let maybe: CheckResult | null = null;
  for (const candidate of candidates) {
    let page: FetchedPage;
    try {
      page = await fetchPage(new URL(candidate));
    } catch {
      continue; // unreachable or refused: not evidence either way
    }
    if (page.status >= 400 || !page.isHtml) continue;
    const match = matchPage(target, { url: page.finalUrl, html: page.body });
    if (match.strong) return { verdict: "found", url: page.finalUrl, evidence: match.evidence };
    if (match.name && !maybe) maybe = { verdict: "unsure", url: page.finalUrl, evidence: match.evidence };
  }
  if (maybe) return maybe;
  return {
    verdict: "none",
    url: null,
    evidence: [
      candidates.length
        ? `searched; ${candidates.length} candidate page${candidates.length === 1 ? "" : "s"} checked, none matched`
        : "searched; no candidate pages",
    ],
  };
}

// ---- Running it over a campaign ---------------------------------------------

/** A verdict is reused this long before the lead is searched again. */
export const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_CHECK_LIMIT = 20;
export const MAX_CHECK_LIMIT = 50;

export interface CheckProgress {
  running: boolean;
  total: number;
  done: number;
  found: number;
  none: number;
  unsure: number;
  error: string | null;
}

const globalForChecks = globalThis as unknown as { onlineChecks?: Map<string, CheckProgress> };
const progressByCampaign = () => (globalForChecks.onlineChecks ??= new Map<string, CheckProgress>());

export function checkProgress(campaignId: string): CheckProgress | null {
  return progressByCampaign().get(campaignId) ?? null;
}

export class CheckInProgressError extends Error {
  constructor() {
    super("The online check for this campaign is already running.");
    this.name = "CheckInProgressError";
  }
}

/** Leads that look offline (site status "None listed") and haven't been searched recently, best first. */
export function leadsToCheck(prisma: PrismaClient, campaignId: string, limit: number, now: Date) {
  return prisma.business.findMany({
    where: {
      campaignId,
      // No website listed, or only a social page or a retired Google site.
      websiteStatus: "NONE_FOUND",
      crmStage: { not: "DEAD" },
      OR: [{ onlineCheckedAt: null }, { onlineCheckedAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) } }],
    },
    include: { campaign: true },
    orderBy: { score: "desc" },
    take: Math.min(Math.max(1, limit), MAX_CHECK_LIMIT),
  });
}

/** Stores a verdict. A site found becomes the lead's website, waiting for the next scan's check. */
export async function applyVerdict(prisma: PrismaClient, leadId: string, result: CheckResult, now: Date) {
  const record = {
    onlineCheck: result.verdict,
    onlineCheckUrl: result.url,
    onlineCheckEvidence: result.evidence.join("; "),
    onlineCheckedAt: now,
  };
  if (result.verdict !== "found") {
    await prisma.business.update({ where: { id: leadId }, data: record });
    return;
  }
  await prisma.$transaction(async (tx) => {
    const lead = await tx.business.findUniqueOrThrow({ where: { id: leadId } });
    // "No website" is no longer true, so it goes; the site itself is assessed by the next scan.
    const analysis = deferWebsiteCheck(lead, `Found online by the web check: ${result.evidence.join("; ")}`);
    await tx.gapSignal.deleteMany({ where: { businessId: leadId } });
    await tx.gapSignal.createMany({ data: analysis.signals.map((s) => ({ ...s, businessId: leadId })) });
    await tx.business.update({
      where: { id: leadId },
      data: {
        ...record,
        website: result.url,
        siteCheckedAt: null,
        websiteStatus: analysis.websiteStatus,
        score: computeScore(analysis.signals, lead),
      },
    });
  });
}

export interface RunDeps extends Partial<CheckDeps> {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * Checks a campaign's offline-looking leads one at a time, so a free search
 * plan's per-minute limit is respected. A busy provider is retried once after
 * a pause; if it is still busy, or the search fails another way, the run stops
 * and says why, and the verdicts so far are kept.
 */
export async function runOnlineCheck(prisma: PrismaClient, campaignId: string, limit = DEFAULT_CHECK_LIMIT, deps: RunDeps = {}) {
  const provider = deps.provider ?? configuredProvider();
  if (!provider) throw new SearchError("No search provider is set up. Set GROQ_API_KEY or TAVILY_API_KEY in .env.");
  const runs = progressByCampaign();
  if (runs.get(campaignId)?.running) throw new CheckInProgressError();

  // Claimed before the first await, so two starts at once can't both run.
  const progress: CheckProgress = { running: true, total: 0, done: 0, found: 0, none: 0, unsure: 0, error: null };
  runs.set(campaignId, progress);

  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  try {
    const leads = await leadsToCheck(prisma, campaignId, limit, now());
    progress.total = leads.length;
    for (const lead of leads) {
      const target = { name: lead.name, phone: lead.phone, address: lead.address, niche: lead.campaign.niche, area: lead.campaign.region };
      let result: CheckResult;
      try {
        result = await checkLeadOnline(target, { provider, fetchPage: deps.fetchPage });
      } catch (err) {
        if (!(err instanceof SearchError && err.busy)) throw err;
        await sleep(20_000);
        result = await checkLeadOnline(target, { provider, fetchPage: deps.fetchPage });
      }
      await applyVerdict(prisma, lead.id, result, now());
      progress.done++;
      progress[result.verdict]++;
    }
  } catch (err) {
    progress.error = err instanceof Error ? err.message : "The online check failed";
  } finally {
    progress.running = false;
  }
  return progress;
}

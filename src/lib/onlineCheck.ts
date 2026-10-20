import type { PrismaClient } from "@/generated/prisma/client";
import { deferWebsiteCheck, websiteNeedsFetch } from "./detect";
import { safeFetchPage, type FetchedPage } from "./safeFetch";
import { isAnyBusiness } from "./sources/anyBusiness";
import { computeScore } from "./score";

/**
 * The second check on a lead that looks offline: a business with no website
 * on OpenStreetMap often has one. A web search suggests candidate pages, and
 * code decides, by fetching each candidate and matching the lead's phone,
 * name and street on it. A search result alone never counts.
 *
 * - found: a page on a domain made of the lead's name shows its phone or its
 *   name. It becomes the lead's website, so the next scan checks it like any
 *   other, and "no website" is no longer claimed.
 * - none: nothing matched. The lead really looks offline.
 * - unsure: a page elsewhere matched (possibly a directory listing), or only
 *   the name did. Flagged for a person to look at.
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
  /** "groq", "openrouter", "tavily", or several in the order they're tried, e.g. "groq + openrouter". */
  name: string;
  /** Candidate URLs for the business, best first. */
  search(target: CheckTarget): Promise<string[]>;
}

export class SearchError extends Error {
  constructor(
    message: string,
    readonly busy = false,
    /** How long the provider asked to wait (its Retry-After), if it said. */
    readonly retryAfterMs: number | null = null
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
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: { error?: unknown } };
      const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.detail?.error);
      if (typeof message === "string") detail = message;
    } catch {}
    // 429 is a rate limit; 402 (OpenRouter), 432 and 433 (Tavily) mean credits ran out.
    const limited = [402, 429, 432, 433].includes(res.status) || res.status >= 500;
    const seconds = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    throw new SearchError(`${label} error ${res.status}: ${detail.slice(0, 200)}`, limited, retryAfterMs);
  }
  // A 200 with an HTML or empty body (a captive portal, a proxy error page) is a failed search,
  // not a crash: the next provider can still answer.
  try {
    return await res.json();
  } catch {
    throw new SearchError(`${label} answered with something that isn't JSON`, true);
  }
}

function query(target: CheckTarget): string {
  return [`"${target.name}"`, typeOf(target), target.area].filter(Boolean).join(" ");
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
  // A backslash ends a URL too: Groq's tool output arrives JSON-escaped, so "\n" follows URLs as text.
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]【】\\]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

/** The business type, for a search: left out for "anything", which isn't a type. */
function typeOf(target: CheckTarget): string {
  return isAnyBusiness(target.niche) ? "" : target.niche;
}

/** What a model with web search is asked: the lead's facts, and URLs back. */
function searchPrompt(target: CheckTarget): string {
  const facts = [
    `Name: ${target.name}`,
    typeOf(target) && `Type: ${typeOf(target)}`,
    `Area: ${target.area}`,
    target.address && `Address: ${target.address}`,
    target.phone && `Phone: ${target.phone}`,
  ].filter(Boolean);
  return (
    `Search the web for this business's own website.\n${facts.join("\n")}\n\n` +
    "Reply with only the URLs of pages that could be its own website, one per line, best first. " +
    "Leave out social media, maps, directories and review sites. If you find none, reply NONE."
  );
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
      const data = (await postJson(
        "https://api.groq.com/openai/v1/chat/completions",
        key,
        {
          model: "openai/gpt-oss-20b",
          tools: [{ type: "browser_search" }],
          tool_choice: "required",
          reasoning_effort: "low",
          messages: [{ role: "user", content: searchPrompt(target) }],
        },
        "Groq"
      )) as { choices?: { message?: { content?: string; executed_tools?: unknown } }[] };
      const message = data.choices?.[0]?.message;
      return [...urlsIn(message?.content ?? ""), ...urlsIn(JSON.stringify(message?.executed_tools ?? ""))];
    },
  };
}

/**
 * OpenRouter's web plugin, on a free model: openrouter/free picks one that is
 * up, since single free models come and go (set OPENROUTER_MODEL to choose).
 * The search results come back as url_citation annotations, whatever the
 * model says; the URLs the model names come first, then those.
 */
export function openRouterProvider(key: string, model = process.env.OPENROUTER_MODEL?.trim() || "openrouter/free"): SearchProvider {
  return {
    name: "openrouter",
    async search(target) {
      const data = (await postJson(
        "https://openrouter.ai/api/v1/chat/completions",
        key,
        {
          model,
          plugins: [{ id: "web", max_results: 8 }],
          reasoning: { effort: "low" },
          messages: [{ role: "user", content: searchPrompt(target) }],
        },
        "OpenRouter"
      )) as {
        error?: { message?: string; code?: number };
        choices?: { message?: { content?: string; annotations?: { url_citation?: { url?: unknown } }[] } }[];
      };
      // OpenRouter can answer 200 and still carry the upstream model's error.
      if (data.error) {
        const code = Number(data.error.code) || 0;
        throw new SearchError(`OpenRouter error ${code}: ${data.error.message ?? "unknown"}`, code === 429 || code >= 500);
      }
      const message = data.choices?.[0]?.message;
      const cited = (message?.annotations ?? []).map((a) => a.url_citation?.url).filter((u): u is string => typeof u === "string");
      return [...urlsIn(message?.content ?? ""), ...cited];
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
          restingUntil.set(p, err.busy ? now() + (err.retryAfterMs ?? REST_AFTER_LIMIT_MS) : Infinity);
          failures.push(err);
        }
      }
      if (failures.length === 0) throw new SearchError("Every search provider failed; check the API keys in .env.");
      const waits = failures.map((f) => f.retryAfterMs).filter((ms): ms is number => ms !== null);
      throw new SearchError(
        failures.map((f) => f.message).join("; "),
        failures.some((f) => f.busy),
        waits.length ? Math.min(...waits) : null
      );
    },
  };
}

/**
 * The configured provider: each one with a key (GROQ_API_KEY,
 * OPENROUTER_API_KEY, TAVILY_API_KEY), tried in that order, or with the one
 * ONLINE_CHECK_PROVIDER names first; each takes over when the one before it
 * hits a limit.
 */
export function configuredProvider(): SearchProvider | null {
  const key = (name: string) => process.env[name]?.trim();
  const groq = key("GROQ_API_KEY");
  const openRouter = key("OPENROUTER_API_KEY");
  const tavily = key("TAVILY_API_KEY");
  const providers = [groq && groqProvider(groq), openRouter && openRouterProvider(openRouter), tavily && tavilyProvider(tavily)].filter(
    (p): p is SearchProvider => Boolean(p)
  );
  const first = providers.findIndex((p) => p.name === process.env.ONLINE_CHECK_PROVIDER?.trim().toLowerCase());
  if (first > 0) providers.unshift(...providers.splice(first, 1));
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
    "pharmacy shop dyqan market agjenci agency group grup ltd llc ne per " +
    "pizzeria pizza kebab doner burger grill sweets lounge caffe coffee bistro pastry autoservis servis service barbershop barber fitness gym"
  ).split(" ")
);

/**
 * The words of a name that tell this business apart. Generic words go, and so
 * do the area's own words in any inflection (Tirana, Tiranë, Tirane): every
 * local page mentions the city, so "Dentist në Tiranë" must not match any
 * dental page in Tirana.
 */
function significantTokens(name: string, area: string): string[] {
  return ownWords(name, area).filter((t) => t.length >= 3);
}

/** The words of a name that are neither generic nor the area's, however short ("aa"). */
function ownWords(name: string, area: string): string[] {
  return normalize(name)
    .split(" ")
    .filter((t) => t.length > 0 && !GENERIC.has(t) && !isAreaWord(t, area));
}

function isAreaWord(word: string, area: string): boolean {
  return normalize(area)
    .split(" ")
    .some((w) => w.length >= 4 && word.slice(0, 5) === w.slice(0, 5));
}

/** The last 8 digits, enough to match a number written with or without its country code. */
function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : null;
}

const STREET_WORDS = new Set(["rruga", "rr", "street", "str", "bulevardi", "blv", "lagjja", "lagja", "nr", "pallati"]);

function streetTokens(address: string | null | undefined, area: string): string[] {
  // The town's name is in every address there ("Suhareke 23000"), in any spelling.
  return normalize(address ?? "")
    .split(" ")
    .filter((t) => t.length >= 4 && !STREET_WORDS.has(t) && !isAreaWord(t, area) && !/^\d+$/.test(t));
}

/** What a page shows of the lead: each piece of evidence, in words. */
export function matchPage(
  target: CheckTarget,
  page: { url: string; html: string }
): { strong: boolean; phone: boolean; name: boolean; local: boolean; ownDomain: boolean; evidence: string[] } {
  const text = normalize(page.html.replace(/<[^>]+>/g, " "));
  const evidence: string[] = [];

  const key = phoneKey(target.phone);
  const phoneOnPage =
    key !== null &&
    // Numbers in a list are separated by "/" or "-", so one run can hold several: look anywhere in it.
    [...page.html.matchAll(/\+?\d[\d\s().\-/]{6,}\d/g)].some((m) => m[0].replace(/\D/g, "").includes(key));
  if (phoneOnPage) evidence.push(`its phone number (${target.phone}) is on the page`);

  // A name made only of generic words ("Klinikë Dentare", "Dentist në Tiranë") is on
  // countless pages, so it never counts; one with a short word of its own counts whole.
  const tokens = significantTokens(target.name, target.area);
  // A short word counts only as a whole word: "era" is inside "Therande".
  const words = ` ${text} `;
  const hasWord = (t: string) => (t.length >= 5 ? text.includes(t) : words.includes(` ${t} `));
  const name =
    tokens.length > 0
      ? tokens.every(hasWord)
      : ownWords(target.name, target.area).length > 0 && text.includes(normalize(target.name));
  if (name) evidence.push(`its name "${target.name}" is on the page`);

  const street = streetTokens(target.address, target.area).find((t) => text.includes(t));
  if (street) evidence.push(`its street ("${street}") is on the page`);

  // Some sign it is this business in this place, not another one with the same name.
  const local = Boolean(street) || text.split(" ").some((w) => isAreaWord(w, target.area));

  const domainName = nameInDomain(target, page.url);
  if (domainName) evidence.push(`the domain contains its name ("${domainName}")`);

  return {
    strong: phoneOnPage || (name && Boolean(street || domainName)),
    phone: phoneOnPage,
    name,
    local,
    ownDomain: domainName !== null,
    evidence,
  };
}

/**
 * The part of the lead's name its URL's domain is made of, if any: a
 * distinctive word of it ("arberi" in arberi.al), or, for a name whose own
 * words are short, the whole name run together (studiodentareaa.com).
 */
function nameInDomain(target: CheckTarget, url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/[^a-z0-9]/g, "");
  } catch {
    return null;
  }
  const tokens = significantTokens(target.name, target.area).map((t) => t.replace(/[^a-z0-9]/g, ""));
  if (tokens.length > 0) return tokens.find((t) => t.length >= 4 && host.includes(t)) ?? null;
  if (ownWords(target.name, target.area).length === 0) return null; // "klinikedentare.com" is anyone's
  const whole = normalize(target.name).replace(/[^a-z0-9]/g, "");
  return whole.length >= 8 && host.includes(whole) ? whole : null;
}

// Sites that list businesses rather than being one, by domain (and its subdomains)...
const DIRECTORY_DOMAINS = [
  "goo.gl", "bing.com", "foursquare.com", "booking.com", "wikipedia.org", "wikimapia.org", "mapcarta.com", "waze.com",
  "apple.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "openstreetmap.org",
  // Seen in live Groq searches for Tirana dentists: each lists the business's phone and street.
  "exa.ai", "geoview.info", "gjirafa.biz", "pikark.com", "dentists10.com", "near-place.com", "albaniayp.com",
  "maps24.net", "openalfa.com", "supernet.al", "dentaltourismalbania.com", "on-mend.com",
];
// ...and by a word in the host name.
const DIRECTORY_WORDS = ["google.", "yelp.", "tripadvisor.", "cylex", "yellowpages", "opendi", "infobel", "kompass", "hotfrog", "zoomaal"];

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
  if (DIRECTORY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  return !DIRECTORY_WORDS.some((w) => host.includes(w));
}

const MAX_CANDIDATES = 5;

export interface CheckDeps {
  provider: SearchProvider;
  fetchPage?: (url: URL) => Promise<FetchedPage>;
}

/**
 * Searches for the lead's own site and verifies each candidate page. Only a
 * page on a domain made of the lead's name can be "found", and only with its
 * phone, or its name and its street or area: directory listings carry a
 * business's phone, name and street too, and no list of directories is ever
 * complete, while another business elsewhere can share the name (MonDent in
 * Tirana, mondent.ba in Bosnia). Anything less is "unsure", for a person to
 * look at: a strong match elsewhere first, then a site named after the lead
 * that didn't load, then a page with its name and its street or area.
 */
export async function checkLeadOnline(target: CheckTarget, deps: CheckDeps): Promise<CheckResult> {
  const fetchPage = deps.fetchPage ?? ((url: URL) => safeFetchPage(url));
  const urls = [...new Set((await deps.provider.search(target)).filter(couldBeOwnSite))];
  // Domains made of the name first: they are the likeliest own sites.
  const candidates = [...urls.filter((u) => nameInDomain(target, u)), ...urls.filter((u) => !nameInDomain(target, u))].slice(0, MAX_CANDIDATES);

  let closeCall: CheckResult | null = null;
  let deadNamesake: CheckResult | null = null;
  let maybe: CheckResult | null = null;
  for (const candidate of candidates) {
    let page: FetchedPage | null = null;
    try {
      page = await fetchPage(new URL(candidate));
    } catch {
      // Unreachable or refused: not evidence either way.
    }
    if (!page || page.status >= 400 || !page.isHtml) {
      const named = nameInDomain(target, candidate);
      if (named && !deadNamesake) {
        const evidence = [`a site named after it (${new URL(candidate).hostname}) didn't load; it may be its old site`];
        deadNamesake = { verdict: "unsure", url: candidate, evidence };
      }
      continue;
    }
    const match = matchPage(target, { url: page.finalUrl, html: page.body });
    if (match.ownDomain && (match.phone || (match.name && match.local))) {
      return { verdict: "found", url: page.finalUrl, evidence: match.evidence };
    }
    if (match.strong && !closeCall) {
      const why = match.ownDomain
        ? `but the page mentions neither its street nor ${target.area}, so it may be another business with this name`
        : "but the domain isn't its name, so this may be a listing";
      closeCall = { verdict: "unsure", url: page.finalUrl, evidence: [...match.evidence, why] };
    }
    // The name alone, with no sign of the street or area, is likely a namesake elsewhere.
    if (match.name && match.local && !maybe) maybe = { verdict: "unsure", url: page.finalUrl, evidence: match.evidence };
  }
  const best = closeCall ?? deadNamesake ?? maybe;
  if (best) return best;
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

const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 20_000;
const MAX_BUSY_WAIT_MS = 65_000;

/**
 * Checks a campaign's offline-looking leads one at a time, so a free search
 * plan's per-minute limit is respected. A busy search is retried up to three
 * times, each after the wait the provider asked for (20 seconds if it didn't
 * say); if it is still busy, or the search fails another way, the run stops
 * and says why, and the verdicts so far are kept.
 */
export async function runOnlineCheck(prisma: PrismaClient, campaignId: string, limit = DEFAULT_CHECK_LIMIT, deps: RunDeps = {}) {
  const provider = deps.provider ?? configuredProvider();
  if (!provider) throw new SearchError("No search provider is set up. Set GROQ_API_KEY, OPENROUTER_API_KEY or TAVILY_API_KEY in .env.");
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
      let result: CheckResult | null = null;
      for (let attempt = 0; !result; attempt++) {
        try {
          result = await checkLeadOnline(target, { provider, fetchPage: deps.fetchPage });
        } catch (err) {
          if (!(err instanceof SearchError && err.busy) || attempt === BUSY_RETRIES) throw err;
          // Wait as long as the provider asked, within reason; Groq's free plan asks for seconds.
          await sleep(Math.min(Math.max(err.retryAfterMs ?? BUSY_WAIT_MS, 1_000), MAX_BUSY_WAIT_MS));
        }
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

import { extractSiteContacts, type SiteContacts } from "./contacts";
import { parseWebsiteUrl, safeFetchPage, SafeFetchError, type FetchedPage } from "./safeFetch";

/**
 * VERIFIED: directly observed (the page loaded and lacks a viewport tag, or the
 * listing carries no website). UNCERTAIN: a single failed or inconclusive check
 * that could be our network, a bot filter or a flaky host rather than a real
 * problem. Uncertain signals are scored at reduced weight and must not be
 * stated as fact in outreach.
 */
export type Certainty = "VERIFIED" | "UNCERTAIN";

export type WebsiteStatus = "NONE_FOUND" | "NEEDS_WORK" | "NEEDS_CHECK" | "GOOD";

export interface DetectedSignal {
  key: string;
  label: string;
  severity: number; // contribution to opportunity score, higher = stronger gap
  certainty: Certainty;
  detail?: string;
}

export interface DetectableBusiness {
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  /** Only used to judge whether the site lets visitors tap to call it. */
  phone?: string | null;
}

export interface PresenceAnalysis {
  signals: DetectedSignal[];
  websiteStatus: WebsiteStatus;
  /** Contact links found on the business's own page, when one was read. */
  contacts?: SiteContacts;
}

export interface DetectDeps {
  /** Replaceable for tests; defaults to the SSRF-guarded fetcher. */
  fetchPage?: (url: URL) => Promise<FetchedPage>;
  /** Replaceable for tests; defaults to the current year. */
  currentYear?: number;
}

// Signals that describe the website itself (as opposed to the listing).
const WEBSITE_KEYS = new Set([
  "site_unreachable",
  "tls_error",
  "site_error",
  "site_not_checked",
  "site_check_deferred",
  "site_unassessed",
  "not_https",
  "no_mobile_viewport",
  "stale_site",
  "site_parked",
  "no_meta_description",
  "no_tap_to_call",
]);

// Listings whose "website" is not a site of their own. Checked from the URL
// alone: nothing is fetched, and the lead counts as having no website.
const SOCIAL_HOSTS = ["facebook.com", "fb.com", "instagram.com", "linktr.ee", "wa.me", "tiktok.com", "m.me"];
// Google shut down Business Profile websites (*.business.site) in 2024.
const RETIRED_HOSTS = ["business.site"];
const NO_OWN_SITE_KEYS = new Set(["social_only", "retired_site"]);

const onHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

function websiteHost(website: string): string | null {
  try {
    return parseWebsiteUrl(website)[0].hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether checking this website means a request. Social and retired sites
 * are settled from the URL alone, so they shouldn't use up a scan's limited
 * website checks.
 */
export function websiteNeedsFetch(website: string | null | undefined): boolean {
  const value = website?.trim();
  return Boolean(value) && noOwnSite(value!) === null;
}

/** A signal for a listing whose website is not really one, or null when it is worth fetching. */
function noOwnSite(website: string): DetectedSignal | null {
  const host = websiteHost(website);
  if (!host) return null;
  if (onHost(host, SOCIAL_HOSTS)) {
    return {
      key: "social_only",
      label: "Uses a social media page instead of a website",
      severity: 35,
      certainty: "VERIFIED",
      detail: host,
    };
  }
  if (onHost(host, RETIRED_HOSTS)) {
    return {
      key: "retired_site",
      label: "Website was a Google Business Profile site, which Google shut down in 2024",
      severity: 40,
      certainty: "VERIFIED",
      detail: host,
    };
  }
  return null;
}

// Phrases a parking or domain-sale page uses; specific enough that a real
// business page doesn't contain them by accident.
const PARKED =
  /this domain (?:name )?(?:is|may be) for sale|buy this domain|domain (?:is )?parked|parked free|parkingcrew|sedoparking|afternic\.com|dan\.com\/buy-domain/i;

const RETRYABLE_KINDS = new Set(["timeout", "connection"]);

function toFetchError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  return new SafeFetchError("connection", err instanceof Error ? err.message : "fetch failed");
}

async function fetchWithRetry(url: URL, fetchPage: (url: URL) => Promise<FetchedPage>): Promise<FetchedPage> {
  let lastError: SafeFetchError | undefined;
  // One retry for transient failures only. A blocked address, a bad URL or a
  // DNS miss won't change on a second attempt.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchPage(url);
    } catch (err) {
      lastError = toFetchError(err);
      if (!RETRYABLE_KINDS.has(lastError.kind)) throw lastError;
    }
  }
  throw lastError;
}

/** Tries each candidate URL in order; the first one that answers wins. */
async function fetchWebsite(candidates: URL[], fetchPage: (url: URL) => Promise<FetchedPage>) {
  let firstError: SafeFetchError | undefined;
  for (const candidate of candidates) {
    try {
      return await fetchWithRetry(candidate, fetchPage);
    } catch (err) {
      const error = toFetchError(err);
      firstError ??= error;
      // An address we refuse to contact is final; don't try another scheme.
      if (error.kind === "blocked" || error.kind === "invalid_url") throw error;
    }
  }
  throw firstError ?? new SafeFetchError("connection", "no candidate URL");
}

const COPYRIGHT_YEARS =
  /(?:©|&copy;|&#169;|&#xa9;|copyright)[^0-9]{0,15}((?:19|20)\d{2})(?:\s*(?:[-–—/,]|&ndash;|&mdash;)\s*((?:19|20)\d{2}))?/gi;

/** Newest year in a copyright notice, counting both ends of "2015-2024". */
export function detectStaleness(html: string, currentYear: number): { stale: boolean; year?: number } {
  const years: number[] = [];
  for (const match of html.matchAll(COPYRIGHT_YEARS)) {
    for (const group of [match[1], match[2]]) {
      if (!group) continue;
      const year = parseInt(group, 10);
      // Allow next year: sites roll their footer over early.
      if (year > 1990 && year <= currentYear + 1) years.push(year);
    }
  }
  if (!years.length) return { stale: false };
  const mostRecent = Math.max(...years);
  return { stale: currentYear - mostRecent >= 3, year: mostRecent };
}

function classifyFailure(error: SafeFetchError): DetectedSignal {
  const detail = [error.kind, error.code, error.message].filter(Boolean).join(": ");
  switch (error.kind) {
    case "blocked":
    case "invalid_url":
      return {
        key: "site_not_checked",
        label: "Website could not be checked",
        severity: 0,
        certainty: "UNCERTAIN",
        detail,
      };
    case "tls":
      return {
        key: "tls_error",
        label: "Website has a security certificate problem",
        severity: 25,
        certainty: "UNCERTAIN",
        detail,
      };
    case "too_many_redirects":
      return {
        key: "site_error",
        label: "Website redirects in a loop",
        severity: 30,
        certainty: "UNCERTAIN",
        detail,
      };
    default:
      return {
        key: "site_unreachable",
        label: "Website did not load",
        severity: 35,
        certainty: "UNCERTAIN",
        detail,
      };
  }
}

/** A non-empty <meta name="description">, whatever the attribute order. */
function hasMetaDescription(html: string): boolean {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/\bname\s*=\s*["']?description\b/i.test(tag) && /\bcontent\s*=\s*(?:"\s*[^"\s]|'\s*[^'\s]|[^\s"'>])/i.test(tag)) {
      return true;
    }
  }
  return false;
}

function analyzePage(page: FetchedPage, currentYear: number, business: DetectableBusiness): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  if (page.status >= 400) {
    // Only a missing page is conclusive. 401/403/429/5xx are often bot filters,
    // rate limits or an outage, not evidence the site is broken for customers.
    const conclusive = page.status === 404 || page.status === 410;
    signals.push({
      key: "site_error",
      label: `Website returned an error (HTTP ${page.status})`,
      severity: 30,
      certainty: conclusive ? "VERIFIED" : "UNCERTAIN",
      detail: String(page.status),
    });
    return signals;
  }

  if (!page.isHtml) {
    signals.push({
      key: "site_unassessed",
      label: "Website did not return a page that could be assessed",
      severity: 0,
      certainty: "UNCERTAIN",
      detail: page.contentType || "unknown content type",
    });
    return signals;
  }

  const html = page.body;

  // A parked page belongs to a registrar, not the business; judging its
  // markup would describe someone else's page.
  if (PARKED.test(html)) {
    signals.push({
      key: "site_parked",
      label: "Website domain is parked or for sale",
      severity: 35,
      certainty: "VERIFIED",
    });
    return signals;
  }

  if (!page.finalUrl.startsWith("https://")) {
    signals.push({ key: "not_https", label: "Site is not served over HTTPS", severity: 15, certainty: "VERIFIED" });
  }

  // A truncated page may have cut off before <head> ends, so a missing tag
  // proves nothing in that case.
  const sawHead = !page.truncated || /<\/head>/i.test(html);
  if (sawHead && !/<meta[^>]+name=["']?viewport/i.test(html)) {
    signals.push({
      key: "no_mobile_viewport",
      label: "Site has no mobile viewport tag (likely not mobile-friendly)",
      severity: 15,
      certainty: "VERIFIED",
    });
  }

  // Search results show this text under the business's name.
  if (sawHead && !hasMetaDescription(html)) {
    signals.push({
      key: "no_meta_description",
      label: "Site gives search engines no description to show",
      severity: 5,
      certainty: "VERIFIED",
    });
  }

  // The footer is where the copyright year lives; a cut-off page may hide a newer one.
  if (!page.truncated) {
    // Only a fully read page proves the link is missing, and only a business
    // with a phone has a number visitors would want to tap.
    if (business.phone?.trim() && !/href\s*=\s*["']?\s*tel:/i.test(html)) {
      signals.push({
        key: "no_tap_to_call",
        label: "Phone number can't be tapped to call on the homepage",
        severity: 5,
        certainty: "VERIFIED",
      });
    }

    const { stale, year } = detectStaleness(html, currentYear);
    if (stale && year) {
      signals.push({
        key: "stale_site",
        label: `Site looks stale (copyright year ${year})`,
        severity: 10,
        certainty: "VERIFIED",
        detail: String(year),
      });
    }
  }

  return signals;
}

function deriveWebsiteStatus(hasWebsite: boolean, signals: DetectedSignal[]): WebsiteStatus {
  // A social page or a retired site is not a website of the business's own.
  if (!hasWebsite || signals.some((s) => NO_OWN_SITE_KEYS.has(s.key))) return "NONE_FOUND";
  const websiteSignals = signals.filter((s) => WEBSITE_KEYS.has(s.key));
  if (websiteSignals.some((s) => s.certainty === "UNCERTAIN")) return "NEEDS_CHECK";
  if (websiteSignals.length > 0) return "NEEDS_WORK";
  return "GOOD";
}

function listingIsEmpty(business: DetectableBusiness): boolean {
  const ratingKnown = typeof business.rating === "number" && Number.isFinite(business.rating);
  const reviewsKnown = typeof business.reviewCount === "number" && Number.isFinite(business.reviewCount);
  // A source that reports no rating/review data at all (OSM never does) says
  // nothing about reviews; only an explicit empty record counts as "thin".
  if (!ratingKnown && !reviewsKnown) return false;
  return !((business.rating ?? 0) > 0) && !((business.reviewCount ?? 0) > 0);
}

const THIN_LISTING: DetectedSignal = {
  key: "thin_listing",
  label: "Little to no online reviews/rating found",
  severity: 10,
  certainty: "VERIFIED",
};

/**
 * Checks only publicly observable signals: does a site exist, does it load,
 * is it served over HTTPS, does it look mobile-friendly, does it look stale.
 * No login, no private data, no invasive probing — this is the same info any
 * visitor sees by loading the page. It never executes anything from the page.
 */
export async function analyzePresence(
  business: DetectableBusiness,
  deps: DetectDeps = {}
): Promise<PresenceAnalysis> {
  const fetchPage = deps.fetchPage ?? ((url: URL) => safeFetchPage(url));
  const currentYear = deps.currentYear ?? new Date().getFullYear();
  const signals: DetectedSignal[] = [];
  let contacts: SiteContacts | undefined;

  const website = business.website?.trim();
  if (!website) {
    signals.push({
      key: "no_website",
      label: "No website found",
      severity: 40,
      certainty: "VERIFIED",
      detail: "The business listing does not include a website",
    });
  } else if (noOwnSite(website)) {
    signals.push(noOwnSite(website)!);
  } else {
    try {
      const page = await fetchWebsite(parseWebsiteUrl(website), fetchPage);
      // A site that redirects to a social page is no site of its own either,
      // and the social page's markup is not the business's to judge.
      const landedOn = noOwnSite(page.finalUrl);
      const pageSignals = landedOn ? [landedOn] : analyzePage(page, currentYear, business);
      signals.push(...pageSignals);
      // Only the business's own real page is read for contacts: not an error
      // page (the host's), a parked page (the registrar's, whose mailto: would
      // be the domain broker's), or a social page it redirected to.
      const ownPage = !landedOn && !pageSignals.some((s) => s.key === "site_parked");
      if (ownPage && page.status < 400 && page.isHtml) contacts = extractSiteContacts(page.body);
    } catch (err) {
      signals.push(classifyFailure(toFetchError(err)));
    }
  }

  if (listingIsEmpty(business)) signals.push({ ...THIN_LISTING });

  return {
    signals,
    websiteStatus: deriveWebsiteStatus(Boolean(website), signals),
    ...(contacts ? { contacts } : {}),
  };
}

/** A signal as the database stores it, where certainty is a plain string column. */
export function fromStoredSignal(stored: {
  key: string;
  label: string;
  severity: number;
  certainty: string;
  detail: string | null;
}): DetectedSignal {
  return {
    key: stored.key,
    label: stored.label,
    severity: stored.severity,
    // The column defaults to VERIFIED; only an explicit UNCERTAIN is uncertain.
    certainty: stored.certainty === "UNCERTAIN" ? "UNCERTAIN" : "VERIFIED",
    detail: stored.detail ?? undefined,
  };
}

/**
 * The analysis of a listing whose website a scan chose not to fetch yet. The
 * listing-level signals still apply; the website is recorded as unchecked,
 * which is inconclusive rather than a gap, so it adds nothing to the score.
 */
export function deferWebsiteCheck(business: DetectableBusiness, detail: string): PresenceAnalysis {
  const signals: DetectedSignal[] = [
    { key: "site_check_deferred", label: "Website not checked yet", severity: 0, certainty: "UNCERTAIN", detail },
  ];
  if (listingIsEmpty(business)) signals.push({ ...THIN_LISTING });
  return { signals, websiteStatus: deriveWebsiteStatus(true, signals) };
}

export async function detectGaps(business: DetectableBusiness, deps?: DetectDeps): Promise<DetectedSignal[]> {
  return (await analyzePresence(business, deps)).signals;
}

import { chromium, type Page } from "playwright";
import { stableSourceRef } from "../dedupe";
import { ANY_BUSINESS_SEARCHES, isAnyBusiness } from "./anyBusiness";
import type { BusinessSource, RawBusiness, SearchBox } from "./types";

/**
 * EXPERIMENTAL / OUT OF TOS.
 *
 * This scrapes Google Maps' web UI directly, which violates Google's Terms of
 * Service (no official scraping allowed; the sanctioned path is the paid
 * Places API). It relies on Google's unstable, unversioned DOM structure, so
 * it WILL break when Google changes markup, and Google may rate-limit or
 * block the IP running it. Use `osmSource` instead unless you've explicitly
 * accepted that risk. Keep volumes small and infrequent.
 */

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";

function parseLatLngFromUrl(url: string): { latitude?: number; longitude?: number } {
  const match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!match) return {};
  return { latitude: parseFloat(match[1]), longitude: parseFloat(match[2]) };
}

function parseRatingReviews(ariaLabel: string | null): { rating?: number; reviewCount?: number } {
  if (!ariaLabel) return {};
  // typical formats: "4.5 stars 128 Reviews" / "4.5 stars, 128 reviews"
  const ratingMatch = ariaLabel.match(/(\d+(?:\.\d+)?)\s*star/i);
  const reviewMatch = ariaLabel.match(/(\d[\d,]*)\s*review/i);
  return {
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : undefined,
    reviewCount: reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ""), 10) : undefined,
  };
}

async function dismissConsentIfPresent(page: Page) {
  try {
    const consentButton = page.getByRole("button", { name: /accept all|i agree|reject all/i }).first();
    if (await consentButton.isVisible({ timeout: 3000 })) {
      await consentButton.click();
    }
  } catch {
    // no consent dialog shown
  }
}

async function extractDetailPane(page: Page): Promise<Pick<RawBusiness, "website" | "phone" | "address">> {
  const detail: Pick<RawBusiness, "website" | "phone" | "address"> = {};

  try {
    const websiteLink = page.locator('a[data-item-id="authority"]').first();
    if (await websiteLink.isVisible({ timeout: 2000 })) {
      detail.website = (await websiteLink.getAttribute("href")) ?? undefined;
    }
  } catch {
    // no website listed
  }

  try {
    const phoneButton = page.locator('button[data-item-id^="phone:tel:"]').first();
    if (await phoneButton.isVisible({ timeout: 1500 })) {
      const itemId = await phoneButton.getAttribute("data-item-id");
      detail.phone = itemId?.replace("phone:tel:", "");
    }
  } catch {
    // no phone listed
  }

  try {
    const addressButton = page.locator('button[data-item-id="address"]').first();
    if (await addressButton.isVisible({ timeout: 1500 })) {
      detail.address = (await addressButton.getAttribute("aria-label"))?.replace(/^Address:\s*/i, "");
    }
  } catch {
    // no address listed
  }

  return detail;
}

// Each place opened is a page load Google sees, so a scan opens a bounded number.
const ONE_TYPE_MAX = 40;
const ANY_BUSINESS_PER_SEARCH = 8;
const ANY_BUSINESS_MAX = 100;
const PAUSE_BETWEEN_SEARCHES_MS = 1500;

export interface SearchPlan {
  queries: string[];
  /** The most listings read from each search. */
  perQuery: number;
  /** The most places opened in the whole scan. */
  total: number;
}

/**
 * What to search for: one search for a business type, or, for "anything",
 * one per common type (see anyBusiness.ts), a few places from each.
 */
export function searchPlan(niche: string, region: string, limit = 25): SearchPlan {
  if (isAnyBusiness(niche)) {
    return { queries: ANY_BUSINESS_SEARCHES.map((type) => `${type} in ${region}`), perQuery: ANY_BUSINESS_PER_SEARCH, total: ANY_BUSINESS_MAX };
  }
  const capped = Math.min(limit, ONE_TYPE_MAX);
  return { queries: [`${niche} in ${region}`], perQuery: capped, total: capped };
}

/**
 * A place's identity in a Maps link: its feature id ("0x…:0x…"), the same
 * whichever search found it, or the link without its query string.
 */
export function placeKey(href: string): string {
  const id = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  return id ? id[1].toLowerCase() : href.split("?")[0];
}

/**
 * The listings of several searches as one list: each place once, taken in
 * turn from each search (its first, then each one's second, …) so every type
 * is represented before the scan's cap is reached.
 */
export function mergeListings<T extends { href: string }>(lists: T[][], total: number): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (let rank = 0; merged.length < total && lists.some((list) => rank < list.length); rank++) {
    for (const list of lists) {
      const item = list[rank];
      if (!item || seen.has(placeKey(item.href))) continue;
      seen.add(placeKey(item.href));
      merged.push(item);
      if (merged.length >= total) break;
    }
  }
  return merged;
}

interface Listing {
  name: string;
  href: string;
  rating?: number;
  reviewCount?: number;
}

/**
 * Splits listings into places the campaign has not got yet, which are opened
 * for their phone, website and address, and places it already has, which are
 * not: opening a place costs a page load, and a re-scan of a town mostly
 * meets places it knows. A known place is still reported, with what the list
 * shows, so the scan marks it as seen again; the details saved earlier stay.
 */
export function splitKnown<T extends { href: string }>(listings: T[], knownRefs: ReadonlySet<string> | undefined): { fresh: T[]; known: T[] } {
  const known = (item: T) => Boolean(knownRefs?.has(stableSourceRef(`gmaps:${item.href}`)));
  return { fresh: listings.filter((item) => !known(item)), known: listings.filter(known) };
}

/** The place listings one search shows, scrolling its results to load up to max. */
async function searchListings(page: Page, query: string, max: number): Promise<Listing[]> {
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await dismissConsentIfPresent(page);

  const feedSelector = 'div[role="feed"]';
  await page.waitForSelector(feedSelector, { timeout: 15000 }).catch(() => null);

  // Scroll the results feed to lazy-load more cards.
  let previousCount = 0;
  for (let i = 0; i < 8; i++) {
    const links = await page.locator(`${feedSelector} a[href*="/maps/place/"]`).count();
    if (links >= max || links === previousCount) break;
    previousCount = links;
    await page.locator(feedSelector).evaluate((el) => el.scrollBy(0, el.scrollHeight));
    await page.waitForTimeout(1200);
  }

  const cardLocator = page.locator(`${feedSelector} a[href*="/maps/place/"]`);
  const cardCount = Math.min(await cardLocator.count(), max);

  // Collect basic info from the list first, since the DOM shifts once we
  // start clicking into detail panes.
  const listings: Listing[] = [];
  for (let i = 0; i < cardCount; i++) {
    try {
      const link = cardLocator.nth(i);
      const href = await link.getAttribute("href");
      const ariaLabel = await link.getAttribute("aria-label");
      if (!href || !ariaLabel) continue;

      const ratingLabel = await link
        .locator("xpath=..")
        .locator('span[role="img"]')
        .first()
        .getAttribute("aria-label")
        .catch(() => null);

      listings.push({ name: ariaLabel, href, ...parseRatingReviews(ratingLabel) });
    } catch {
      continue;
    }
  }
  return listings;
}

export const googleMapsScraperSource: BusinessSource = {
  id: "GOOGLE_MAPS_SCRAPER",
  async search({ region, niche, limit = 25, onProgress, knownRefs }: SearchBox): Promise<RawBusiness[]> {
    const plan = searchPlan(niche, region, limit);
    const say = (message: string) => onProgress?.(message);
    const browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
    });

    try {
      const page = await browser.newPage({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        viewport: { width: 1280, height: 900 },
      });

      const lists: Listing[][] = [];
      let lastError: unknown = null;
      for (const [i, query] of plan.queries.entries()) {
        if (i > 0) await page.waitForTimeout(PAUSE_BETWEEN_SEARCHES_MS);
        say(`Searching "${query}" (${i + 1}/${plan.queries.length})`);
        try {
          lists.push(await searchListings(page, query, plan.perQuery));
        } catch (err) {
          // One search failing (a timeout, a changed page) shouldn't lose the others.
          if (plan.queries.length === 1) throw err;
          lastError = err;
          lists.push([]);
        }
      }
      // Every search failing (a captcha, a changed layout) is a failed scan, not an empty town.
      if (lastError && lists.every((list) => list.length === 0)) throw lastError;

      const businesses: RawBusiness[] = [];
      const { fresh, known } = splitKnown(mergeListings(lists, plan.total), knownRefs);
      for (const item of known) {
        // Already saved: what the list shows is enough to mark it seen again.
        businesses.push({ name: item.name, rating: item.rating, reviewCount: item.reviewCount, sourceRef: `gmaps:${item.href}` });
      }
      for (const [n, item] of fresh.entries()) {
        say(`Opening new places ${n + 1}/${fresh.length}${known.length ? ` (${known.length} already known, not reopened)` : ""}`);
        try {
          await page.goto(item.href, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(800); // let the detail pane render
          const { latitude, longitude } = parseLatLngFromUrl(page.url());
          const detail = await extractDetailPane(page);

          businesses.push({
            name: item.name,
            rating: item.rating,
            reviewCount: item.reviewCount,
            latitude,
            longitude,
            sourceRef: `gmaps:${item.href}`,
            ...detail,
          });
        } catch {
          // detail page failed to load; still record the basic listing
          businesses.push({ name: item.name, rating: item.rating, reviewCount: item.reviewCount, sourceRef: `gmaps:${item.href}` });
        }
      }

      return businesses;
    } finally {
      await browser.close();
    }
  },
};

import { chromium, type Page } from "playwright";
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

export const googleMapsScraperSource: BusinessSource = {
  id: "GOOGLE_MAPS_SCRAPER",
  async search({ region, niche, limit = 25 }: SearchBox): Promise<RawBusiness[]> {
    const cappedLimit = Math.min(limit, 40); // keep runs short & low-volume by design
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

      const query = `${niche} in ${region}`;
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
        if (links >= cappedLimit || links === previousCount) break;
        previousCount = links;
        await page.locator(feedSelector).evaluate((el) => el.scrollBy(0, el.scrollHeight));
        await page.waitForTimeout(1200);
      }

      const cardLocator = page.locator(`${feedSelector} a[href*="/maps/place/"]`);
      const cardCount = Math.min(await cardLocator.count(), cappedLimit);

      // Collect basic info from the list first, since the DOM shifts once we
      // start clicking into detail panes.
      const basics: Array<{ name: string; href: string; rating?: number; reviewCount?: number }> = [];
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

          basics.push({ name: ariaLabel, href, ...parseRatingReviews(ratingLabel) });
        } catch {
          continue;
        }
      }

      const businesses: RawBusiness[] = [];
      for (const item of basics) {
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

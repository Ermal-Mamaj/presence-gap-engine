export interface DetectedSignal {
  key: string;
  label: string;
  severity: number; // contribution to opportunity score, higher = stronger gap
  detail?: string;
}

export interface DetectableBusiness {
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
}

const FETCH_TIMEOUT_MS = 8000;

function normalizeUrl(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return `http://${raw}`;
  return raw;
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timeout);
  }
}

function detectStaleness(html: string): { stale: boolean; year?: number } {
  const matches = [...html.matchAll(/(?:©|copyright)\D{0,10}(\d{4})/gi)];
  if (!matches.length) return { stale: false };
  const years = matches.map((m) => parseInt(m[1], 10)).filter((y) => y > 1990 && y <= new Date().getFullYear());
  if (!years.length) return { stale: false };
  const mostRecent = Math.max(...years);
  return { stale: new Date().getFullYear() - mostRecent >= 3, year: mostRecent };
}

/**
 * Checks only publicly observable signals: does a site exist, does it load,
 * is it served over HTTPS, does it look mobile-friendly, does it look stale.
 * No login, no private data, no invasive probing — this is the same info any
 * visitor sees by loading the page.
 */
export async function detectGaps(business: DetectableBusiness): Promise<DetectedSignal[]> {
  const signals: DetectedSignal[] = [];

  if (!business.website) {
    signals.push({
      key: "no_website",
      label: "No website found",
      severity: 40,
    });
  } else {
    const url = normalizeUrl(business.website);
    const usesHttps = url.startsWith("https://");

    let response: Response | null = null;
    let html = "";
    try {
      response = await fetchWithTimeout(url, { method: "GET" });
      html = await response.text();
    } catch (err) {
      signals.push({
        key: "site_unreachable",
        label: "Website did not load",
        severity: 35,
        detail: err instanceof Error ? err.message : "fetch failed",
      });
    }

    if (response) {
      if (!response.ok) {
        signals.push({
          key: "site_error",
          label: `Website returned an error (HTTP ${response.status})`,
          severity: 30,
          detail: String(response.status),
        });
      }

      const finalUrlIsHttps = response.url.startsWith("https://");
      if (!usesHttps && !finalUrlIsHttps) {
        signals.push({
          key: "not_https",
          label: "Site is not served over HTTPS",
          severity: 15,
        });
      }

      if (html) {
        const hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(html);
        if (!hasViewportMeta) {
          signals.push({
            key: "no_mobile_viewport",
            label: "Site has no mobile viewport tag (likely not mobile-friendly)",
            severity: 15,
          });
        }

        const { stale, year } = detectStaleness(html);
        if (stale && year) {
          signals.push({
            key: "stale_site",
            label: `Site looks stale (copyright year ${year})`,
            severity: 10,
            detail: String(year),
          });
        }
      }
    }
  }

  if (!business.rating && !business.reviewCount) {
    signals.push({
      key: "thin_listing",
      label: "Little to no online reviews/rating found",
      severity: 10,
    });
  }

  return signals;
}

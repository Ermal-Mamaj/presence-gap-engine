/**
 * Requests to the two public OpenStreetMap services the OSM source depends on,
 * with the manners each one asks for. Both are free, shared and often busy, so
 * a scan should wait or go elsewhere rather than fail on the first refusal.
 */

import type { OverpassElement } from "./osm";

// Both services ask clients to identify themselves. Nominatim's usage policy
// requires it, and overpass-api.de refuses a request without one with HTTP 406
// before running the query.
export const USER_AGENT = "presence-gap-engine/0.1 (lead-research tool)";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Overpass is told to give up after 25s server-side (see the query builder);
// the client waits a little longer so it sees that answer instead of a hang.
const NOMINATIM_TIMEOUT_MS = 15_000;
const OVERPASS_TIMEOUT_MS = 40_000;

// The main instance often answers 504 ("too busy") or 429 (no free slot for
// this client), which used to fail the whole scan. The mirror serves the same
// data. Override with OVERPASS_URLS, comma-separated.
const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** Pause before each round; a round tries every server once. */
const OVERPASS_ROUND_DELAYS_MS = [0, 15_000, 45_000];

// Statuses that say "not now" rather than "never": rate limited, overloaded,
// or a gateway that gave up. Anything else (400 for a bad query, 406 for a
// missing User-Agent) fails the same way on every server.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// Nominatim's usage policy: at most one request per second for the whole
// application, and cache results instead of asking again.
const NOMINATIM_INTERVAL_MS = 1_000;
const GEOCODE_CACHE_MS = 24 * 60 * 60 * 1000;

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Worth trying again later or on another server. */
class TransientOverpassError extends Error {}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function queryOnce(url: string, query: string): Promise<OverpassElement[]> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
      body: query,
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new TransientOverpassError(`${hostOf(url)} ${reason}`);
  }

  if (!res.ok) {
    const message = `Overpass API error: ${res.status} ${res.statusText}`;
    if (TRANSIENT_STATUSES.has(res.status)) throw new TransientOverpassError(message);
    throw new Error(message);
  }

  let data: { elements?: OverpassElement[]; remark?: string };
  try {
    data = await res.json();
  } catch {
    throw new TransientOverpassError(`${hostOf(url)} returned an unreadable response`);
  }
  if (!Array.isArray(data?.elements)) {
    throw new Error("Overpass API returned an unexpected response");
  }
  // On overload or timeout Overpass still answers 200, with a remark and
  // whatever it managed to collect. A silently truncated list would look like
  // a real (small) result, so treat it as a failure, one another server or a
  // later attempt may not have.
  if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) {
    throw new TransientOverpassError(`Overpass API could not finish the query: ${data.remark}`);
  }
  return data.elements;
}

export function overpassUrls(): string[] {
  const configured = process.env.OVERPASS_URLS?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_OVERPASS_URLS;
}

export interface OverpassDeps {
  urls?: string[];
  sleep?: Sleep;
  roundDelaysMs?: number[];
}

/**
 * Runs one Overpass query, trying each server in turn and pausing between
 * rounds. A refusal that would repeat everywhere fails immediately.
 */
export async function fetchOverpass(query: string, deps: OverpassDeps = {}): Promise<OverpassElement[]> {
  const urls = deps.urls ?? overpassUrls();
  const sleep = deps.sleep ?? realSleep;
  const delays = deps.roundDelaysMs ?? OVERPASS_ROUND_DELAYS_MS;

  let attempts = 0;
  let last: Error | undefined;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    for (const url of urls) {
      attempts++;
      try {
        return await queryOnce(url, query);
      } catch (err) {
        if (!(err instanceof TransientOverpassError)) throw err;
        last = err;
      }
    }
  }
  throw new Error(
    `Overpass API is busy: ${attempts} attempts on ${urls.length} server${urls.length === 1 ? "" : "s"} failed ` +
      `(last: ${last?.message ?? "unknown"}). Try again in a few minutes.`
  );
}

export interface Geocoded {
  lat: number;
  lon: number;
  /** [south, north, west, east], as Nominatim returns it. */
  boundingbox: [string, string, string, string];
}

export interface GeocoderDeps {
  sleep?: Sleep;
  now?: () => number;
}

/**
 * A Nominatim client that never sends more than one request per second and
 * remembers each region for a day. One instance is shared by the whole
 * process, so concurrent scans of different campaigns queue behind each other
 * rather than each keeping its own pace.
 */
export function createGeocoder(deps: GeocoderDeps = {}) {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Geocoded }>();
  let nextSlot = 0;

  async function waitForTurn() {
    const at = Math.max(now(), nextSlot);
    // Claimed before waiting, so callers that arrive together get distinct slots.
    nextSlot = at + NOMINATIM_INTERVAL_MS;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  }

  return async function geocode(region: string): Promise<Geocoded | null> {
    const key = region.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < GEOCODE_CACHE_MS) return hit.value;

    await waitForTurn();
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", region);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Nominatim error: ${res.status} ${res.statusText}`);
    const results = (await res.json()) as Array<{ lat: string; lon: string; boundingbox: [string, string, string, string] }>;
    // "No such place" is an answer, not a failure, but it is not cached: a
    // typo fixed in the campaign should be looked up again.
    if (!Array.isArray(results) || !results.length) return null;
    const r = results[0];
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Array.isArray(r.boundingbox) || r.boundingbox.length !== 4) {
      throw new Error("Nominatim returned an unexpected response");
    }
    const value: Geocoded = { lat, lon, boundingbox: r.boundingbox };
    cache.set(key, { at: now(), value });
    return value;
  };
}

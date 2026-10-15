/**
 * Requests to the two public OpenStreetMap services the OSM source depends on,
 * with the manners each one asks for. Both are free, shared and often busy, so
 * a scan should wait or go elsewhere rather than fail on the first refusal,
 * but it should also stop quickly when waiting can't help.
 */

// Type-only, so the two modules don't load each other at runtime.
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

/** Pause before each round; a round tries every remaining server once. */
const OVERPASS_ROUND_DELAYS_MS = [0, 15_000, 45_000];

/**
 * All the retrying together stays within this, so discovery can't take most
 * of a scan's time budget (the run route asks for 300s where that is
 * enforced): an attempt that couldn't finish before it isn't started.
 */
const OVERPASS_DEADLINE_MS = 150_000;

/** The longest a server's Retry-After is honoured; beyond it, the next round's pause applies. */
const MAX_RETRY_AFTER_MS = 60_000;

// Statuses that say "not now" rather than "never": rate limited, overloaded,
// or a gateway that gave up. Anything else (400 for a bad query, 404 for a
// moved endpoint) is that server's final answer.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// Nominatim's usage policy: at most one request per second for the whole
// application, and cache results instead of asking again.
const NOMINATIM_INTERVAL_MS = 1_000;
const GEOCODE_CACHE_MS = 24 * 60 * 60 * 1000;
const GEOCODE_CACHE_MAX = 500;
const NOMINATIM_RETRY_DELAY_MS = 2_000;

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Worth trying again later, or on another server. */
class TransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 0
  ) {
    super(message);
  }
}

/**
 * The server ran the query and gave up on its size (its own timeout or memory
 * limit). Another server might manage it; asking the same ones again later
 * won't help.
 */
class HeavyQueryError extends Error {}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A Retry-After header in milliseconds (seconds or an HTTP date), capped; 0 when absent or unreadable. */
function retryAfterMs(res: Response): number {
  const header = res.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(header).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 0;
}

/**
 * A failed fetch, sorted. A timeout or a network failure (which carries the
 * underlying error as `cause`) may clear up; anything else, such as a URL
 * that can't be parsed, never will, and its message is kept so the real
 * problem is visible.
 */
function fetchFailure(err: unknown, url: string): Error {
  const host = hostOf(url);
  if (err instanceof Error && err.name === "TimeoutError") return new TransientError(`${host} timed out`);
  if (err instanceof Error && err.cause) {
    const cause = err.cause as { code?: string; message?: string };
    return new TransientError(`${host} could not be reached (${cause.code ?? cause.message ?? "network error"})`);
  }
  return new Error(`${host}: ${err instanceof Error ? err.message : "request failed"}`);
}

async function queryOnce(url: string, query: string): Promise<OverpassElement[]> {
  const host = hostOf(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
      body: query,
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
    });
  } catch (err) {
    throw fetchFailure(err, url);
  }

  if (!res.ok) {
    const message = `Overpass API error from ${host}: ${res.status} ${res.statusText}`;
    if (TRANSIENT_STATUSES.has(res.status)) throw new TransientError(message, retryAfterMs(res));
    throw new Error(message);
  }

  let data: { elements?: OverpassElement[]; remark?: string };
  try {
    data = await res.json();
  } catch {
    throw new TransientError(`${host} returned an unreadable response`);
  }
  if (!Array.isArray(data?.elements)) {
    throw new Error(`${host} returned an unexpected response`);
  }
  // On overload or timeout Overpass still answers 200, with a remark and
  // whatever it managed to collect. A silently truncated list would look like
  // a real (small) result, so treat it as a failure.
  if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) {
    throw new HeavyQueryError(`Overpass API could not finish the query on ${host}: ${data.remark}`);
  }
  return data.elements;
}

/** The configured Overpass servers; entries that aren't http(s) URLs are ignored. */
export function overpassUrls(): string[] {
  const configured = (process.env.OVERPASS_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => {
      try {
        return ["http:", "https:"].includes(new URL(u).protocol);
      } catch {
        return false;
      }
    });
  return configured.length ? configured : DEFAULT_OVERPASS_URLS;
}

export interface OverpassDeps {
  urls?: string[];
  sleep?: Sleep;
  now?: () => number;
  roundDelaysMs?: number[];
  deadlineMs?: number;
  /** How long one attempt may take, for the deadline arithmetic. */
  attemptMs?: number;
}

/**
 * Runs one Overpass query across the servers in turn, pausing between
 * rounds (longer if a server said when to come back). How each failure is
 * handled depends on what it means:
 *
 * - busy, rate-limited, unreachable: try the next server, then a later round;
 * - a server's final answer (400, 404, a malformed reply): drop that server
 *   and carry on with the others; only when none is left does it fail;
 * - the query is too heavy for every server: fail now, saying so, since
 *   waiting won't make the region smaller.
 */
export async function fetchOverpass(query: string, deps: OverpassDeps = {}): Promise<OverpassElement[]> {
  const urls = deps.urls ?? overpassUrls();
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const delays = deps.roundDelaysMs ?? OVERPASS_ROUND_DELAYS_MS;
  const deadline = deps.deadlineMs ?? OVERPASS_DEADLINE_MS;
  const attemptMs = deps.attemptMs ?? OVERPASS_TIMEOUT_MS;
  const started = now();
  const timeLeftFor = (ms: number) => now() - started + ms <= deadline;

  let servers = [...urls];
  let attempts = 0;
  let last: Error | undefined;
  let comeBackAfter = 0;

  for (let round = 0; round < delays.length; round++) {
    const pause = Math.max(delays[round], comeBackAfter);
    if (round > 0 && !timeLeftFor(pause + attemptMs)) break;
    if (pause > 0) await sleep(pause);
    comeBackAfter = 0;

    let tooHeavyEverywhere = true;
    for (const url of [...servers]) {
      if (attempts > 0 && !timeLeftFor(attemptMs)) break;
      attempts++;
      try {
        return await queryOnce(url, query);
      } catch (err) {
        last = err instanceof Error ? err : new Error(String(err));
        if (err instanceof HeavyQueryError) continue;
        tooHeavyEverywhere = false;
        if (err instanceof TransientError) {
          comeBackAfter = Math.max(comeBackAfter, err.retryAfterMs);
          continue;
        }
        servers = servers.filter((s) => s !== url);
        if (servers.length === 0) throw last;
      }
    }
    if (tooHeavyEverywhere && last) {
      throw new Error(`${last.message}. The region is probably too large for one query; try a smaller one.`);
    }
  }
  throw new Error(
    `Overpass API is busy: ${attempts} attempt${attempts === 1 ? "" : "s"} on ${urls.length} server${urls.length === 1 ? "" : "s"} failed ` +
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
 * A Nominatim client that never sends more than one request per second,
 * remembers each region for a day, asks once for a region several scans want
 * at the same time, and tries a busy server once more before giving up.
 */
export function createGeocoder(deps: GeocoderDeps = {}) {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Geocoded }>();
  const inFlight = new Map<string, Promise<Geocoded | null>>();
  let nextSlot = 0;

  async function waitForTurn() {
    const at = Math.max(now(), nextSlot);
    // Claimed before waiting, so callers that arrive together get distinct slots.
    nextSlot = at + NOMINATIM_INTERVAL_MS;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  }

  async function request(region: string): Promise<Response> {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", region);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    for (let attempt = 0; ; attempt++) {
      await waitForTurn();
      let failure: Error;
      try {
        const res = await fetch(url.toString(), {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
        });
        if (res.ok) return res;
        failure = TRANSIENT_STATUSES.has(res.status)
          ? new TransientError(`Nominatim error: ${res.status} ${res.statusText}`, retryAfterMs(res))
          : new Error(`Nominatim error: ${res.status} ${res.statusText}`);
      } catch (err) {
        failure = fetchFailure(err, NOMINATIM_URL);
      }
      if (!(failure instanceof TransientError) || attempt >= 1) throw failure;
      await sleep(Math.max(NOMINATIM_RETRY_DELAY_MS, failure.retryAfterMs));
    }
  }

  async function lookUp(region: string, key: string): Promise<Geocoded | null> {
    const res = await request(region);
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
    // Map keeps insertion order, so the first key is the oldest.
    if (cache.size > GEOCODE_CACHE_MAX) cache.delete(cache.keys().next().value!);
    return value;
  }

  return async function geocode(region: string): Promise<Geocoded | null> {
    const key = region.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit) {
      if (now() - hit.at < GEOCODE_CACHE_MS) return hit.value;
      cache.delete(key);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const lookup = lookUp(region, key).finally(() => inFlight.delete(key));
    inFlight.set(key, lookup);
    return lookup;
  };
}

const globalForGeocoder = globalThis as unknown as { osmGeocoder?: ReturnType<typeof createGeocoder> };

/**
 * The one geocoder for the whole process. Kept on globalThis like the Prisma
 * client, so a dev-server reload, or a second copy of this module in another
 * bundle, can't start a second rate limiter with its own empty cache.
 */
export function sharedGeocoder(): ReturnType<typeof createGeocoder> {
  return (globalForGeocoder.osmGeocoder ??= createGeocoder());
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeocoder, fetchOverpass, overpassUrls } from "@/lib/sources/osmClient";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const MAIN = "https://main.example/api/interpreter";
const MIRROR = "https://mirror.example/api/interpreter";
const ELEMENTS = [{ type: "node", id: 1, tags: { name: "Klinika" } }];

/** A fake fetch that answers each call from a script, recording which server was asked. */
function scriptedFetch(answers: Array<() => Response | Promise<Response>>) {
  const hosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      hosts.push(new URL(String(url)).hostname);
      const next = answers.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    })
  );
  return hosts;
}
const ok = () => Response.json({ elements: ELEMENTS });
const status = (code: number) => () => new Response("busy", { status: code, statusText: "Busy" });
const unreachable = () => {
  throw new TypeError("fetch failed");
};

function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}
const deps = (sleep = fakeSleep().sleep) => ({ urls: [MAIN, MIRROR], sleep, roundDelaysMs: [0, 15_000, 45_000] });

describe("fetchOverpass", () => {
  it("returns the first server's answer when it has one", async () => {
    const hosts = scriptedFetch([ok]);
    expect(await fetchOverpass("q", deps())).toEqual(ELEMENTS);
    expect(hosts).toEqual(["main.example"]);
  });

  it.each([
    ["too busy (504)", status(504)],
    ["rate limited (429)", status(429)],
    ["unavailable (503)", status(503)],
    ["unreachable", unreachable],
    ["out of memory, with a 200", () => Response.json({ elements: [], remark: "runtime error: Query run out of memory" })],
  ])("tries the mirror when the main server is %s", async (_, failure) => {
    const hosts = scriptedFetch([failure, ok]);
    expect(await fetchOverpass("q", deps())).toEqual(ELEMENTS);
    expect(hosts).toEqual(["main.example", "mirror.example"]);
  });

  it("does not retry a refusal that every server would repeat", async () => {
    const hosts = scriptedFetch([status(406)]);
    await expect(fetchOverpass("q", deps())).rejects.toThrow("Overpass API error: 406");
    expect(hosts).toEqual(["main.example"]);
  });

  it("pauses between rounds, and recovers when the main server frees up", async () => {
    const { waits, sleep } = fakeSleep();
    const hosts = scriptedFetch([status(504), status(504), ok]);
    expect(await fetchOverpass("q", deps(sleep))).toEqual(ELEMENTS);
    expect(hosts).toEqual(["main.example", "mirror.example", "main.example"]);
    expect(waits).toEqual([15_000]);
  });

  it("gives up with a message that says what happened and what to do", async () => {
    const { waits, sleep } = fakeSleep();
    scriptedFetch(Array.from({ length: 6 }, () => status(504)));
    await expect(fetchOverpass("q", deps(sleep))).rejects.toThrow(
      /Overpass API is busy: 6 attempts on 2 servers failed \(last: Overpass API error: 504 Busy\)\. Try again/
    );
    expect(waits).toEqual([15_000, 45_000]);
  });
});

describe("overpassUrls", () => {
  it("uses the main instance first, with a mirror behind it", () => {
    const urls = overpassUrls();
    expect(new URL(urls[0]).hostname).toBe("overpass-api.de");
    expect(urls.length).toBeGreaterThan(1);
  });

  it("can be overridden", () => {
    vi.stubEnv("OVERPASS_URLS", ` ${MIRROR} ,, ${MAIN}`);
    expect(overpassUrls()).toEqual([MIRROR, MAIN]);
  });
});

describe("createGeocoder", () => {
  const place = [{ lat: "41.33", lon: "19.82", boundingbox: ["41.29", "41.37", "19.75", "19.88"] }];

  function clockAndFetch(answer: () => Response = () => Response.json(place)) {
    let t = 0;
    const requestedAt: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requestedAt.push(t);
        return answer();
      })
    );
    const geocode = createGeocoder({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    return { geocode, requestedAt, advance: (ms: number) => (t += ms) };
  }

  it("sends at most one request per second, even when scans ask at once", async () => {
    // Three callers at the same instant: each must wait for its own slot.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(place)));
    const waits: number[] = [];
    const geocode = createGeocoder({ now: () => 0, sleep: async (ms) => void waits.push(ms) });
    await Promise.all([geocode("Tirana"), geocode("Durres"), geocode("Vlore")]);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("does not wait when the last request was long enough ago", async () => {
    const { geocode, requestedAt, advance } = clockAndFetch();
    await geocode("Tirana");
    advance(5_000);
    await geocode("Durres");
    expect(requestedAt).toEqual([0, 5_000]);
  });

  it("remembers a region for a day instead of asking again", async () => {
    const { geocode, requestedAt, advance } = clockAndFetch();
    const first = await geocode("Tirana, Albania");
    expect(await geocode("  tirana, albania ")).toEqual(first);
    expect(requestedAt).toHaveLength(1);

    advance(24 * 60 * 60 * 1000);
    await geocode("Tirana, Albania");
    expect(requestedAt).toHaveLength(2);
  });

  it("asks again for a region it could not find, which may since have been corrected", async () => {
    const { geocode, requestedAt } = clockAndFetch(() => Response.json([]));
    expect(await geocode("Tiranna")).toBeNull();
    expect(await geocode("Tiranna")).toBeNull();
    expect(requestedAt).toHaveLength(2);
  });
});

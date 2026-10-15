import { afterEach, describe, expect, it, vi } from "vitest";
import { osmSource } from "@/lib/sources/osm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("osmSource requests", () => {
  it("identifies itself to both Nominatim and Overpass", async () => {
    // overpass-api.de answers a request without a User-Agent with HTTP 406, so
    // a missing header fails every scan before the query runs.
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return String(url).includes("nominatim")
          ? Response.json([{ lat: "41.33", lon: "19.82", boundingbox: ["41.29", "41.37", "19.75", "19.88"] }])
          : Response.json({ elements: [] });
      })
    );

    await osmSource.search({ region: "Tirana, Albania", niche: "dentist" });

    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["nominatim.openstreetmap.org", "overpass-api.de"]);
    for (const call of calls) {
      expect(call.headers.get("user-agent")).toMatch(/^presence-gap-engine\//);
    }
  });
});

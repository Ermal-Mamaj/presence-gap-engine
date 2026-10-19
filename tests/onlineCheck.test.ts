import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLeadOnline,
  configuredProvider,
  couldBeOwnSite,
  groqProvider,
  matchPage,
  runOnlineCheck,
  type SearchProvider,
  SearchError,
  tavilyProvider,
  urlsIn,
} from "@/lib/onlineCheck";
import type { FetchedPage } from "@/lib/safeFetch";
import { createTestDb } from "./helpers/db";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const target = { name: "Klinika Dentare Arbëri", phone: "+355 69 123 4567", address: "Rruga Myslym Shyri 12", niche: "dentist", area: "Tirana" };
const page = (url: string, body: string, overrides: Partial<FetchedPage> = {}): FetchedPage => ({
  status: 200,
  finalUrl: url,
  contentType: "text/html",
  isHtml: true,
  body,
  truncated: false,
  redirects: 0,
  ...overrides,
});
const provider = (urls: string[]): SearchProvider => ({ name: "tavily", search: async () => urls });

describe("urlsIn", () => {
  it("reads URLs out of prose, without punctuation or citation marks", () => {
    expect(urlsIn("Best: https://arberi.al/kontakt. Also (https://x.example/a)【2†L6】and http://y.example")).toEqual([
      "https://arberi.al/kontakt",
      "https://x.example/a",
      "http://y.example",
    ]);
  });
});

describe("couldBeOwnSite", () => {
  it.each([
    ["https://arberi.al", true],
    ["https://www.facebook.com/arberi", false],
    ["https://www.google.com/maps/place/x", false],
    ["https://www.tripadvisor.com/x", false],
    ["https://www.cylex.al/arberi", false],
    ["ftp://arberi.al", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(couldBeOwnSite(url)).toBe(expected);
  });
});

describe("matchPage", () => {
  it("counts the phone, written any way, as a strong match", () => {
    const match = matchPage(target, { url: "https://x.al", html: "<p>Tel: 069 123 4567</p>" });
    expect(match.strong).toBe(true);
    expect(match.evidence[0]).toContain("phone");
  });

  it("needs the distinctive words of the name, not the generic ones", () => {
    // "Klinika Dentare" is on every dental page; "Arbëri" is what identifies it.
    expect(matchPage(target, { url: "https://x.al", html: "Klinika Dentare në Tiranë" }).name).toBe(false);
    expect(matchPage(target, { url: "https://x.al", html: "Klinika Dentare ARBERI" }).name).toBe(true);
  });

  it("doesn't count the city as part of the name, however it is spelled", () => {
    // Found live: "Dentist ne Tirane" matched via a domain containing "tirane".
    const cityNamed = { ...target, name: "Dentist ne Tirane", phone: null };
    const anyTiranaPage = { url: "https://dentistnetirane.example", html: "Klinika dentare në Tiranë" };
    expect(matchPage(cityNamed, anyTiranaPage).strong).toBe(false);
    // With no distinctive word left, the whole name must appear, and alone it is only "unsure".
    const theirPage = { url: "https://dentistnetirane.example", html: "Dentist ne Tirane, Rruga e Kavajes" };
    expect(matchPage(cityNamed, theirPage)).toMatchObject({ strong: false, name: true });
  });

  it("is strong with the name and the street, or a domain made of the name; weak with the name alone", () => {
    expect(matchPage(target, { url: "https://x.al", html: "Arbëri, Rruga Myslym Shyri" }).strong).toBe(true);
    expect(matchPage(target, { url: "https://arberi.al", html: "Arbëri" }).strong).toBe(true);
    const weak = matchPage(target, { url: "https://x.al", html: "Arbëri" });
    expect(weak).toMatchObject({ strong: false, name: true });
  });
});

describe("checkLeadOnline", () => {
  it("finds the page that matches, skipping directories and pages that fail", async () => {
    const fetched: string[] = [];
    const result = await checkLeadOnline(target, {
      provider: provider(["https://www.facebook.com/arberi", "https://down.example", "https://arberi.al"]),
      fetchPage: async (url) => {
        fetched.push(url.hostname);
        if (url.hostname === "down.example") throw new Error("ECONNREFUSED");
        return page(url.toString(), "<h1>Klinika Arbëri</h1><p>+355 69 123 4567</p>");
      },
    });
    expect(fetched).toEqual(["down.example", "arberi.al"]);
    expect(result).toMatchObject({ verdict: "found", url: "https://arberi.al/" });
  });

  it("is unsure when only the name matched, and none when nothing did", async () => {
    const nameOnly = await checkLeadOnline(target, {
      provider: provider(["https://maybe.example"]),
      fetchPage: async (url) => page(url.toString(), "Arbëri"),
    });
    expect(nameOnly.verdict).toBe("unsure");

    const nothing = await checkLeadOnline(target, {
      provider: provider(["https://other.example"]),
      fetchPage: async (url) => page(url.toString(), "Some other business"),
    });
    expect(nothing).toEqual({ verdict: "none", url: null, evidence: ["searched; 1 candidate page checked, none matched"] });
  });

  it("doesn't trust an error page", async () => {
    const result = await checkLeadOnline(target, {
      provider: provider(["https://arberi.al"]),
      fetchPage: async (url) => page(url.toString(), "+355 69 123 4567", { status: 404 }),
    });
    expect(result.verdict).toBe("none");
  });
});

describe("search providers", () => {
  function stub(answer: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(answer), { status });
      })
    );
    return calls;
  }

  it("asks Tavily for a basic search and returns its result URLs", async () => {
    const calls = stub({ results: [{ url: "https://arberi.al" }, { url: 7 }] });
    expect(await tavilyProvider("tvly-key").search(target)).toEqual(["https://arberi.al"]);
    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-key");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ search_depth: "basic", max_results: 8 });
  });

  it("asks Groq to browse with gpt-oss, and reads URLs from its answer", async () => {
    const calls = stub({ choices: [{ message: { content: "https://arberi.al\nhttps://x.example【1】" } }] });
    expect(await groqProvider("gsk-key").search(target)).toEqual(["https://arberi.al", "https://x.example"]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      model: "openai/gpt-oss-20b",
      tools: [{ type: "browser_search" }],
    });
  });

  it("marks a rate limit as busy, so a run can wait and retry", async () => {
    stub({ error: "rate limited" }, 429);
    await expect(tavilyProvider("k").search(target)).rejects.toMatchObject({ busy: true });
  });

  it("uses Groq when its key is set, Tavily otherwise, or the one asked for", () => {
    expect(configuredProvider()).toBeNull();
    vi.stubEnv("TAVILY_API_KEY", "t");
    expect(configuredProvider()?.name).toBe("tavily");
    vi.stubEnv("GROQ_API_KEY", "g");
    expect(configuredProvider()?.name).toBe("groq");
    vi.stubEnv("ONLINE_CHECK_PROVIDER", "tavily");
    expect(configuredProvider()?.name).toBe("tavily");
  });
});

describe("runOnlineCheck", () => {
  const db = createTestDb();
  const { prisma } = db;
  afterAll(() => db.cleanup());

  let campaignId: string;
  beforeEach(async () => {
    campaignId = (await prisma.campaign.create({ data: { name: "c", region: "Tirana", niche: "dentist" } })).id;
  });

  async function offlineLead(name: string, extra: Record<string, unknown> = {}) {
    return prisma.business.create({
      data: {
        campaignId,
        name,
        dedupeKey: name,
        phone: "+355 69 123 4567",
        websiteStatus: "NONE_FOUND",
        score: 44,
        signals: { create: [{ key: "no_website", label: "No website found", severity: 40 }] },
        ...extra,
      },
    });
  }

  it("makes a verified site the lead's website, and stops claiming it has none", async () => {
    const lead = await offlineLead("Arbëri");
    const progress = await runOnlineCheck(prisma, campaignId, 20, {
      provider: provider(["https://arberi.al"]),
      fetchPage: async (url) => page(url.toString(), "Arbëri +355 69 123 4567"),
    });
    expect(progress).toMatchObject({ running: false, total: 1, done: 1, found: 1, error: null });

    const saved = await prisma.business.findUniqueOrThrow({ where: { id: lead.id }, include: { signals: true } });
    expect(saved).toMatchObject({ website: "https://arberi.al/", websiteStatus: "NEEDS_CHECK", siteCheckedAt: null, onlineCheck: "found", score: 0 });
    expect(saved.signals.map((s) => s.key)).toEqual(["site_check_deferred"]);
    expect(saved.onlineCheckEvidence).toContain("phone");
  });

  it("records a lead that really looks offline, and doesn't search it again for a month", async () => {
    const lead = await offlineLead("Nowhere");
    const search = vi.fn(async () => []);
    await runOnlineCheck(prisma, campaignId, 20, { provider: { name: "tavily", search } });
    expect(await prisma.business.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ onlineCheck: "none", website: null });
    expect((await prisma.gapSignal.findMany({ where: { businessId: lead.id } })).map((s) => s.key)).toEqual(["no_website"]);

    await runOnlineCheck(prisma, campaignId, 20, { provider: { name: "tavily", search } });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("only checks leads with no site of their own", async () => {
    await offlineLead("Has a site", { websiteStatus: "GOOD", website: "https://has.al" });
    const search = vi.fn(async () => []);
    expect((await runOnlineCheck(prisma, campaignId, 20, { provider: { name: "tavily", search } })).total).toBe(0);
  });

  it("waits and retries a busy search once, then stops and says why, keeping verdicts so far", async () => {
    await offlineLead("A", { score: 50 });
    await offlineLead("B", { score: 40 });
    let calls = 0;
    const waits: number[] = [];
    const progress = await runOnlineCheck(prisma, campaignId, 20, {
      provider: {
        name: "tavily",
        search: async () => {
          calls++;
          if (calls === 1) return [];
          throw new SearchError("Tavily error 429: slow down", true);
        },
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([20_000]);
    expect(progress).toMatchObject({ done: 1, none: 1, error: "Tavily error 429: slow down" });
  });

  it("refuses to start without a provider", async () => {
    await expect(runOnlineCheck(prisma, campaignId)).rejects.toThrow(/GROQ_API_KEY or TAVILY_API_KEY/);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLeadOnline,
  configuredProvider,
  couldBeOwnSite,
  fallbackProvider,
  groqProvider,
  openRouterProvider,
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

  it("ends a URL at a backslash, as in Groq's JSON-escaped tool output", () => {
    // Found live: "http://studiodentareaa.com/\nL2" and "...com/\\" came back as URLs.
    expect(urlsIn(JSON.stringify("see http://studiodentareaa.com/\nL2 and https://a.al\\"))).toEqual(["http://studiodentareaa.com/", "https://a.al"]);
  });
});

describe("couldBeOwnSite", () => {
  it.each([
    ["https://arberi.al", true],
    ["https://www.facebook.com/arberi", false],
    ["https://www.google.com/maps/place/x", false],
    ["https://www.tripadvisor.com/x", false],
    ["https://www.cylex.al/arberi", false],
    ["https://exa.ai/library/place/h7cxhh05k4r", false],
    ["https://al.geoview.info/studio_dentare_aa,5849142224n", false],
    ["https://dentix.com", true], // not x.com

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
    // With no word of its own left, the name is on countless pages: it never counts, only the phone does.
    const theirPage = { url: "https://x.example", html: "Dentist ne Tirane, Rruga e Kavajes" };
    expect(matchPage(cityNamed, theirPage)).toMatchObject({ strong: false, name: false });
    // Found live: "Klinikë Dentare" was "maybe online" at another clinic's site.
    expect(matchPage({ ...target, name: "Klinikë Dentare" }, { url: "https://klinikakristi.al", html: "Klinikë Dentare Kristi" }).name).toBe(false);
  });

  it("doesn't take a short word inside another word, the type of business, or the town for the lead", () => {
    // Found live: Pizzeria ERA in Suharekë was "found" at pizzeriaguri.blogspot.com, a different pizzeria.
    const era = { name: "Pizzeria ERA", phone: "+38344624696", address: "Suhareke 23000", niche: "Anything", area: "Suharek, Kosovo" };
    const guri = { url: "http://pizzeriaguri.blogspot.com/", html: "Pizzeria Guri Peqan Suhareke, Therande, Restaurant Pizzeria Guri" };
    expect(matchPage(era, guri)).toMatchObject({ strong: false, name: false, ownDomain: false });
    // ...while the real one, with "era" as a word of its own, still matches.
    expect(matchPage(era, { url: "https://pizzeriaera.com", html: "Pizzeria ERA, Suharekë" })).toMatchObject({ name: true });
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
      provider: provider(["https://www.facebook.com/arberi", "https://arberi.down.example", "https://arberi.al"]),
      fetchPage: async (url) => {
        fetched.push(url.hostname);
        if (url.hostname === "arberi.down.example") throw new Error("ECONNREFUSED");
        return page(url.toString(), "<h1>Klinika Arbëri</h1><p>+355 69 123 4567</p>");
      },
    });
    expect(fetched).toEqual(["arberi.down.example", "arberi.al"]);
    expect(result).toMatchObject({ verdict: "found", url: "https://arberi.al/" });
  });

  it("is unsure when only the name matched, here; none when nothing did, or only a namesake elsewhere", async () => {
    const nameOnly = await checkLeadOnline(target, {
      provider: provider(["https://maybe.example"]),
      fetchPage: async (url) => page(url.toString(), "Arbëri, Tiranë"),
    });
    expect(nameOnly.verdict).toBe("unsure");

    // Found live: "Ada Dental" in Tirana was "maybe online" at a clinic in Romania.
    const namesake = await checkLeadOnline(target, {
      provider: provider(["https://maybe.example"]),
      fetchPage: async (url) => page(url.toString(), "Arbëri, București"),
    });
    expect(namesake.verdict).toBe("none");

    const nothing = await checkLeadOnline(target, {
      provider: provider(["https://other.example"]),
      fetchPage: async (url) => page(url.toString(), "Some other business"),
    });
    expect(nothing).toEqual({ verdict: "none", url: null, evidence: ["searched; 1 candidate page checked, none matched"] });
  });

  it("is only unsure about a matching page on a domain that isn't the name: it may be a listing", async () => {
    // Found live: an unknown directory showed the phone, name and street, and was taken as the site.
    const result = await checkLeadOnline(target, {
      provider: provider(["https://new-directory.example/place/123"]),
      fetchPage: async (url) => page(url.toString(), "Klinika Dentare Arbëri, Rruga Myslym Shyri, +355 69 123 4567"),
    });
    expect(result).toMatchObject({ verdict: "unsure", url: "https://new-directory.example/place/123" });
    expect(result.evidence.at(-1)).toMatch(/may be a listing/);
  });

  it("tries domains made of the name first, and reads a name of generic words run together", async () => {
    const fetched: string[] = [];
    const result = await checkLeadOnline(
      { ...target, name: "Studio Dentare aa", phone: "0692050118" },
      {
        provider: provider([1, 2, 3, 4, 5].map((n) => `https://listing${n}.example/aa`).concat("http://studiodentareaa.com/")),
        fetchPage: async (url) => {
          fetched.push(url.hostname);
          return page(url.toString(), "Studio Dentare aa · 069 205 0118");
        },
      }
    );
    expect(fetched[0]).toBe("studiodentareaa.com");
    expect(result).toMatchObject({ verdict: "found", url: "http://studiodentareaa.com/" });
  });

  it("doesn't trust an error page", async () => {
    const result = await checkLeadOnline(target, {
      provider: provider(["https://other.example"]),
      fetchPage: async (url) => page(url.toString(), "+355 69 123 4567", { status: 404 }),
    });
    expect(result.verdict).toBe("none");
  });

  it("is unsure about a site named after the lead that doesn't load: it may be its old site", async () => {
    // Found live: studiodentareaa.com no longer answers.
    const result = await checkLeadOnline(target, {
      provider: provider(["https://arberi.al"]),
      fetchPage: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result).toMatchObject({ verdict: "unsure", url: "https://arberi.al", evidence: [expect.stringMatching(/didn't load/)] });

    // Found live: "Klinikë Dentare" took klinikedentare.com, a name anyone could have, as its old site.
    const generic = await checkLeadOnline({ ...target, name: "Klinikë Dentare" }, {
      provider: provider(["http://www.klinikedentare.com/"]),
      fetchPage: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(generic.verdict).toBe("none");
  });

  it("wants the street or the area on a namesake domain without the phone: it may be a business elsewhere", async () => {
    // Found live: Klinika Dentare MonDent in Tirana was "found" at mondent.ba, a clinic in Bosnia.
    const mondent = { ...target, name: "Klinika Dentare MonDent", phone: "+355697476106", address: "Rruga Pandi Dardha" };
    const elsewhere = await checkLeadOnline(mondent, {
      provider: provider(["https://mondent.ba/en/"]),
      fetchPage: async (url) => page(url.toString(), "MonDent dental clinic, Sarajevo, +387 33 123 456"),
    });
    expect(elsewhere).toMatchObject({ verdict: "unsure", evidence: expect.arrayContaining([expect.stringMatching(/another business/)]) });

    const here = await checkLeadOnline(mondent, {
      provider: provider(["https://mondent.al/"]),
      fetchPage: async (url) => page(url.toString(), "MonDent, klinikë dentare në Tiranë"),
    });
    expect(here.verdict).toBe("found");
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

  it("marks a rate limit as busy, with the wait it asks for and its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "Rate limit reached for model `openai/gpt-oss-20b`" } }, { status: 429, headers: { "retry-after": "7" } })
      )
    );
    await expect(groqProvider("k").search(target)).rejects.toMatchObject({
      busy: true,
      retryAfterMs: 7_000,
      message: "Groq error 429: Rate limit reached for model `openai/gpt-oss-20b`",
    });
  });

  it("treats Tavily's out-of-credits answer as a limit", async () => {
    stub({ detail: { error: "plan limit exceeded" } }, 432);
    await expect(tavilyProvider("k").search(target)).rejects.toMatchObject({ busy: true });
  });

  it("uses each key that is set, Groq then OpenRouter then Tavily, or the one asked for first", () => {
    for (const name of ["GROQ_API_KEY", "OPENROUTER_API_KEY", "TAVILY_API_KEY", "ONLINE_CHECK_PROVIDER"]) vi.stubEnv(name, "");
    expect(configuredProvider()).toBeNull();
    vi.stubEnv("TAVILY_API_KEY", "t");
    expect(configuredProvider()?.name).toBe("tavily");
    vi.stubEnv("GROQ_API_KEY", "g");
    expect(configuredProvider()?.name).toBe("groq + tavily");
    vi.stubEnv("OPENROUTER_API_KEY", "o");
    expect(configuredProvider()?.name).toBe("groq + openrouter + tavily");
    vi.stubEnv("ONLINE_CHECK_PROVIDER", "tavily");
    expect(configuredProvider()?.name).toBe("tavily + groq + openrouter");
  });

  it("asks OpenRouter for a web search on a free model, and reads the model's URLs, then the results", async () => {
    const calls = stub({
      choices: [
        {
          message: {
            content: "http://studiodentareaa.com/",
            annotations: [{ type: "url_citation", url_citation: { url: "https://exa.ai/library/place/x" } }, { type: "other" }],
          },
        },
      ],
    });
    expect(await openRouterProvider("sk-or-key").search(target)).toEqual(["http://studiodentareaa.com/", "https://exa.ai/library/place/x"]);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: "openrouter/free", plugins: [{ id: "web" }] });
  });

  it("takes an OpenRouter error inside a 200 answer as an error, and out of credits as a limit", async () => {
    stub({ error: { code: 429, message: "google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream" } });
    await expect(openRouterProvider("k").search(target)).rejects.toMatchObject({ busy: true, message: expect.stringContaining("rate-limited") });
    stub({ error: { message: "Insufficient credits" } }, 402);
    await expect(openRouterProvider("k").search(target)).rejects.toMatchObject({ busy: true });
  });
});

describe("fallbackProvider", () => {
  function scripted(name: string, answers: (string[] | SearchError)[]) {
    const p = {
      name,
      calls: 0,
      async search() {
        const answer = answers[Math.min(p.calls++, answers.length - 1)];
        if (answer instanceof SearchError) throw answer;
        return answer;
      },
    };
    return p;
  }
  const limited = (name: string) => new SearchError(`${name} error 429: limit`, true);

  it("hands over when the first hits its limit, and goes back to it after a minute", async () => {
    let clock = 0;
    const groq = scripted("groq", [limited("Groq"), ["https://from-groq.al"]]);
    const tavily = scripted("tavily", [["https://from-tavily.al"]]);
    const both = fallbackProvider([groq, tavily], () => clock);

    expect(await both.search(target)).toEqual(["https://from-tavily.al"]);
    clock = 30_000;
    expect(await both.search(target)).toEqual(["https://from-tavily.al"]);
    expect(groq.calls).toBe(1); // resting, not asked again
    clock = 61_000;
    expect(await both.search(target)).toEqual(["https://from-groq.al"]);
    expect(tavily.calls).toBe(2);
  });

  it("rests a provider for as long as it asked, when it said", async () => {
    let clock = 0;
    const groq = scripted("groq", [new SearchError("Groq error 429: limit", true, 5_000), ["https://from-groq.al"]]);
    const tavily = scripted("tavily", [["https://from-tavily.al"]]);
    const both = fallbackProvider([groq, tavily], () => clock);
    await both.search(target);
    clock = 6_000;
    expect(await both.search(target)).toEqual(["https://from-groq.al"]);
  });

  it("passes over a rejected key for good", async () => {
    let clock = 0;
    const groq = scripted("groq", [new SearchError("Groq error 401: invalid key")]);
    const tavily = scripted("tavily", [["https://x.al"]]);
    const both = fallbackProvider([groq, tavily], () => clock);
    await both.search(target);
    clock = 10 * 60_000;
    await both.search(target);
    expect(groq.calls).toBe(1);
  });

  it("is busy, naming both, when both are at their limit; and tries them again rather than none", async () => {
    const groq = scripted("groq", [limited("Groq")]);
    const tavily = scripted("tavily", [limited("Tavily")]);
    const both = fallbackProvider([groq, tavily], () => 0);
    await expect(both.search(target)).rejects.toMatchObject({ busy: true, message: "Groq error 429: limit; Tavily error 429: limit" });
    await expect(both.search(target)).rejects.toMatchObject({ busy: true });
    expect([groq.calls, tavily.calls]).toEqual([2, 2]);
  });

  it("says to check the keys when every key was rejected", async () => {
    const both = fallbackProvider([scripted("groq", [new SearchError("Groq error 401: invalid key")])], () => 0);
    await expect(both.search(target)).rejects.toMatchObject({ busy: false, message: "Groq error 401: invalid key" });
    await expect(both.search(target)).rejects.toThrow(/check the API keys/);
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

  it("waits as long as a busy provider asks before retrying", async () => {
    await offlineLead("A");
    let calls = 0;
    const waits: number[] = [];
    const progress = await runOnlineCheck(prisma, campaignId, 20, {
      provider: {
        name: "groq",
        search: async () => {
          if (++calls === 1) throw new SearchError("Groq error 429: try again in 7s", true, 7_000);
          return [];
        },
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([7_000]);
    expect(progress).toMatchObject({ done: 1, none: 1, error: null });
  });

  it("retries a busy search three times, then stops and says why, keeping verdicts so far", async () => {
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
    expect(waits).toEqual([20_000, 20_000, 20_000]);
    expect(progress).toMatchObject({ done: 1, none: 1, error: "Tavily error 429: slow down" });
  });

  it("refuses to start without a provider", async () => {
    await expect(runOnlineCheck(prisma, campaignId)).rejects.toThrow(/GROQ_API_KEY, OPENROUTER_API_KEY or TAVILY_API_KEY/);
  });
});

describe("problems found in review", () => {
  it("finds the first of two numbers listed together", () => {
    const first = { ...target, phone: "044 123 456" };
    const html = "<p>Tel: 044 123 456 / 069 123 4567</p>";
    expect(matchPage(first, { url: "https://x.al", html }).phone).toBe(true);
    expect(matchPage({ ...target, phone: "069 123 4567" }, { url: "https://x.al", html }).phone).toBe(true);
    expect(matchPage({ ...target, phone: "069 999 0000" }, { url: "https://x.al", html }).phone).toBe(false);
  });

  it("leaves 'anything' out of what it asks a search provider", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return Response.json({ results: [], choices: [{ message: { content: "NONE" } }] });
      })
    );
    const anything = { ...target, niche: "Anything" };
    await tavilyProvider("k").search(anything);
    await groqProvider("k").search(anything);
    expect(bodies.join(" ")).not.toMatch(/anything/i);
    await tavilyProvider("k").search(target);
    expect(bodies.at(-1)).toContain("dentist");
  });

  it("treats an answer that isn't JSON as a failed search, so the next provider can answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in to the wifi</html>", { status: 200 })));
    await expect(tavilyProvider("k").search(target)).rejects.toMatchObject({ busy: true });
    const next = { name: "tavily", search: async () => ["https://arberi.al"] };
    const first = { name: "groq", search: async () => groqProvider("k").search(target) };
    expect(await fallbackProvider([first, next], () => 0).search(target)).toEqual(["https://arberi.al"]);
  });
});

describe("a directory listing is not a site of its own", () => {
  // Found live: dyqani.app and restaurantguru.com list the lead's phone beside hundreds of others.
  const others = (n: number) => Array.from({ length: n }, (_, i) => `<li>+355 69 ${String(100 + i).padStart(3, "0")} ${String(1000 + i)}</li>`).join("");

  it("is 'listed' when its phone is on a page of many other numbers", async () => {
    const result = await checkLeadOnline(target, {
      provider: provider(["https://places.example/arberi"]),
      fetchPage: async (url) => page(url.toString(), `<h1>Klinika Dentare Arbëri</h1><p>+355 69 123 4567</p><ul>${others(40)}</ul>`),
    });
    expect(result).toMatchObject({ verdict: "listed", url: "https://places.example/arberi" });
    expect(result.evidence.at(-1)).toMatch(/directory/);
  });

  it("is still 'unsure' for a page with only a few numbers on another domain", async () => {
    const result = await checkLeadOnline(target, {
      provider: provider(["https://rad-barbershop.square.site/"]),
      fetchPage: async (url) => page(url.toString(), `<p>Klinika Arbëri +355 69 123 4567, Tel 044 111 222</p>`),
    });
    expect(result.verdict).toBe("unsure");
  });

  it("is only 'listed' if nothing looked like a site of its own", async () => {
    const result = await checkLeadOnline(target, {
      provider: provider(["https://places.example/arberi", "https://maybe.example"]),
      fetchPage: async (url) =>
        page(url.toString(), url.hostname === "places.example" ? `Arbëri +355 69 123 4567 ${others(40)}` : "Arbëri, Tiranë"),
    });
    expect(result.verdict).toBe("unsure");
  });

  it("never turns a lead's own domain into a listing, however many numbers it shows", async () => {
    const result = await checkLeadOnline(target, {
      provider: provider(["https://arberi.al"]),
      fetchPage: async (url) => page(url.toString(), `Arbëri +355 69 123 4567 ${others(40)}`),
    });
    expect(result.verdict).toBe("found");
  });

  it("skips the registry and directories seen live, without fetching them", () => {
    for (const url of ["https://arbk.org/biz/dental-praxis-shpk/", "https://dyqani.app/places/cafe/soho", "https://restaurantguru.com/x"]) {
      expect(couldBeOwnSite(url)).toBe(false);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { guessDomains, guessOwnSite, MAX_GUESSES } from "@/lib/domainGuess";
import { SafeFetchError, type FetchedPage } from "@/lib/safeFetch";

const area = "Suharek, Kosovo";
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
const troi = { name: "TROI Restaurant", phone: "+38348555706", address: "Rr.Mehmet Bytyçi 70 ,Reshtan, Suharekë 23000", niche: "restaurant", area };

/** A web where only these hosts answer. */
function web(sites: Record<string, string | Partial<FetchedPage> | Error>) {
  return vi.fn(async (url: URL) => {
    const site = sites[url.hostname];
    if (site === undefined) throw new Error("ENOTFOUND");
    if (site instanceof Error) throw site;
    return typeof site === "string" ? page(`https://${url.hostname}/`, site) : page(`https://${url.hostname}/`, "", site);
  });
}

describe("guessDomains", () => {
  // Found live: leads the search called "unsure" or "none" that have these sites.
  it.each([
    ["TROI Restaurant", "troi-restaurant.com"],
    ["Posantio Doner", "posantio.com"],
    ["Dental Praxis", "dentalpraxis-ks.com"],
    ["Restaurant Nori Suharekë", "norirestaurant.com"],
    ["Klinika Dentare Arbëri", "arberi.com"],
  ])("%s → %s", (name, domain) => {
    expect(guessDomains({ name, area })).toContain(domain);
  });

  it("uses the country's own endings", () => {
    expect(guessDomains({ name: "Arbëri", area: "Tirana, Albania" })).toContain("arberi.al");
    expect(guessDomains({ name: "Arbëri", area: "Berlin" })).toEqual(["arberi.com"]);
  });

  it("guesses nothing for a name that is only a type of business or the town", () => {
    expect(guessDomains({ name: "Klinikë Dentare", area })).toEqual([]);
    expect(guessDomains({ name: "Restaurant Suhareka", area })).toEqual([]);
    expect(guessDomains({ name: "💈", area })).toEqual([]);
  });

  it("stays within its limit, with only valid host names", () => {
    for (const name of ["Barbershop Ard&Lan", "Flija ma e Shijshme n’Qytet", 'Autoshkolla "URA"', "A B C D E F G H Very Long Name Of Something Local"]) {
      const guesses = guessDomains({ name, area });
      expect(guesses.length).toBeLessThanOrEqual(MAX_GUESSES);
      for (const g of guesses) expect(g).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]\.[a-z]+$/);
      expect(new Set(guesses).size).toBe(guesses.length);
    }
  });
});

describe("guessOwnSite", () => {
  it("finds a site by its name and the lead's phone", async () => {
    const result = await guessOwnSite(troi, { fetchPage: web({ "troi-restaurant.com": "<h1>Troi</h1> Tel 048 555 706" }) });
    expect(result).toMatchObject({ verdict: "found", url: "https://troi-restaurant.com/" });
    expect(result?.evidence.join()).toMatch(/phone number.*guessed from its name/);
  });

  it("takes a namesake elsewhere for nothing", async () => {
    expect(await guessOwnSite(troi, { fetchPage: web({ "troi.com": "Troi Consulting, Boston. +1 617 555 0101" }) })).toBeNull();
  });

  it("is only unsure when the name and town match but the phone doesn't", async () => {
    const result = await guessOwnSite(troi, { fetchPage: web({ "troi.com": "Troi, Suharekë. 044 111 222" }) });
    expect(result).toMatchObject({ verdict: "unsure", url: "https://troi.com/" });
  });

  it("prefers a site with the phone to one without, whichever answers first", async () => {
    const result = await guessOwnSite(troi, {
      fetchPage: web({ "troi.com": "Troi, Suharekë. 044 111 222", "troi-restaurant.com": "Troi 048555706" }),
    });
    expect(result).toMatchObject({ verdict: "found", url: "https://troi-restaurant.com/" });
  });

  it("doesn't count a domain for existing: error pages, files, parked redirects", async () => {
    expect(
      await guessOwnSite(troi, {
        fetchPage: web({
          "troi.com": { status: 403, body: "Troi 048555706" },
          "troi.net": { isHtml: false },
          "troi-ks.com": new Error("timeout"),
          "restauranttroi.com": { finalUrl: "https://directory.example/listing", body: "Troi Suharekë 048 555 706" },
        }),
      })
    ).toBeNull();
  });

  it("doesn't take the country in a list of countries for the town", async () => {
    // Found live: greengarden.com ships to Kosovo.
    expect(await guessOwnSite(troi, { fetchPage: web({ "troi.com": "Troi ships to Albania, Kosovo, Serbia. +1 617 555 0101" }) })).toBeNull();
  });

  it("is unsure about a certificate problem, only on the whole name with the country's suffix", async () => {
    // Found live: dentalpraxis-ks.com sends an incomplete certificate chain.
    const praxis = { ...troi, name: "Dental Praxis", phone: "+38348154111" };
    const tls = new SafeFetchError("tls", "unable to verify the first certificate");
    expect(await guessOwnSite(praxis, { fetchPage: web({ "dentalpraxis-ks.com": tls }) })).toMatchObject({
      verdict: "unsure",
      url: "https://dentalpraxis-ks.com/",
    });
    expect(await guessOwnSite(praxis, { fetchPage: web({ "dentalpraxis.com": tls, "praxis-ks.com": tls }) })).toBeNull();
    expect(await guessOwnSite(praxis, { fetchPage: web({ "dentalpraxis-ks.com": new SafeFetchError("timeout", "slow") }) })).toBeNull();
  });

  it("tries nothing without a phone to recognise the lead by", async () => {
    const fetchPage = web({});
    expect(await guessOwnSite({ ...troi, phone: null }, { fetchPage })).toBeNull();
    expect(await guessOwnSite({ ...troi, phone: "112" }, { fetchPage })).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("stops asking once it has found the site", async () => {
    const fetchPage = web({ "troi.com": "Troi 048 555 706" });
    await guessOwnSite(troi, { fetchPage });
    expect(fetchPage.mock.calls.length).toBeLessThan(guessDomains(troi).length);
  });
});

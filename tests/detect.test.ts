import { describe, expect, it, vi } from "vitest";
import { analyzePresence, deferWebsiteCheck, detectGaps, detectStaleness, websiteNeedsFetch } from "@/lib/detect";
import { SafeFetchError, type FetchedPage } from "@/lib/safeFetch";

const GOOD_HTML =
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Family dentist in Tirana"></head><body>© 2026 Example</body></html>';

const page = (overrides: Partial<FetchedPage> = {}): FetchedPage => ({
  status: 200,
  finalUrl: "https://example.com/",
  contentType: "text/html",
  isHtml: true,
  body: GOOD_HTML,
  truncated: false,
  redirects: 0,
  ...overrides,
});

const deps = (fetchPage: (url: URL) => Promise<FetchedPage>) => ({ fetchPage, currentYear: 2026 });
const keys = (signals: { key: string }[]) => signals.map((s) => s.key);

describe("analyzePresence: listing without a website", () => {
  it.each([undefined, null, "", "   "])("reports no website for %j without fetching anything", async (website) => {
    const fetchPage = vi.fn();
    const result = await analyzePresence({ website }, deps(fetchPage));
    expect(keys(result.signals)).toEqual(["no_website"]);
    expect(result.websiteStatus).toBe("NONE_FOUND");
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe("analyzePresence: a healthy site", () => {
  it("has no website signals and is GOOD", async () => {
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page()));
    expect(result.signals).toEqual([]);
    expect(result.websiteStatus).toBe("GOOD");
  });
});

describe("analyzePresence: failed requests are not proof that there is no website", () => {
  it("never reports no_website for a site that fails to load", async () => {
    const fail = async () => {
      throw new SafeFetchError("connection", "boom", "ECONNREFUSED");
    };
    const result = await analyzePresence({ website: "https://example.com" }, deps(fail));
    expect(keys(result.signals)).not.toContain("no_website");
    expect(result.websiteStatus).not.toBe("NONE_FOUND");
  });

  it("records a single failed load as an uncertain observation that needs a check", async () => {
    const fail = async () => {
      throw new SafeFetchError("connection", "boom", "ECONNREFUSED");
    };
    const result = await analyzePresence({ website: "https://example.com" }, deps(fail));
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ key: "site_unreachable", certainty: "UNCERTAIN" });
    expect(result.websiteStatus).toBe("NEEDS_CHECK");
  });

  it("retries a timeout once before giving up", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new SafeFetchError("timeout", "slow"));
    await analyzePresence({ website: "https://example.com" }, deps(fetchPage));
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    const fetchPage = vi.fn().mockRejectedValueOnce(new SafeFetchError("timeout", "slow")).mockResolvedValueOnce(page());
    const result = await analyzePresence({ website: "https://example.com" }, deps(fetchPage));
    expect(result.websiteStatus).toBe("GOOD");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not retry a DNS failure", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new SafeFetchError("dns", "no such host", "ENOTFOUND"));
    const result = await analyzePresence({ website: "https://nope.example" }, deps(fetchPage));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.signals[0]).toMatchObject({ key: "site_unreachable", certainty: "UNCERTAIN" });
  });

  it("reports a certificate failure as an uncertain security problem", async () => {
    const fail = async () => {
      throw new SafeFetchError("tls", "certificate has expired", "CERT_HAS_EXPIRED");
    };
    const result = await analyzePresence({ website: "https://example.com" }, deps(fail));
    expect(result.signals[0]).toMatchObject({ key: "tls_error", certainty: "UNCERTAIN" });
    expect(result.websiteStatus).toBe("NEEDS_CHECK");
  });

  it("treats a non-error exception from the fetcher as an uncertain failure", async () => {
    const fail = async () => {
      throw new TypeError("weird");
    };
    const result = await analyzePresence({ website: "https://example.com" }, deps(fail));
    expect(result.signals[0]).toMatchObject({ key: "site_unreachable", certainty: "UNCERTAIN" });
  });
});

describe("analyzePresence: unsafe or malformed website values", () => {
  it.each(["javascript:alert(1)", "mailto:owner@example.com", "data:text/html,<h1>x</h1>", "not a url", "ftp://example.com"])(
    "does not fetch %j and asks for a manual check",
    async (website) => {
      const fetchPage = vi.fn();
      const result = await analyzePresence({ website }, deps(fetchPage));
      expect(fetchPage).not.toHaveBeenCalled();
      expect(result.signals[0]).toMatchObject({ key: "site_not_checked", severity: 0, certainty: "UNCERTAIN" });
      expect(result.websiteStatus).toBe("NEEDS_CHECK");
    }
  );

  it("reports a refused destination as not checked, not as a broken site", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new SafeFetchError("blocked", "private address"));
    const result = await analyzePresence({ website: "http://10.0.0.5/" }, deps(fetchPage));
    expect(result.signals[0]).toMatchObject({ key: "site_not_checked", certainty: "UNCERTAIN" });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe("analyzePresence: scheme-less website values", () => {
  it("tries https first and stops there when it works", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page());
    const result = await analyzePresence({ website: "example.com" }, deps(fetchPage));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0].protocol).toBe("https:");
    expect(result.websiteStatus).toBe("GOOD");
  });

  it("falls back to http for a site that only serves plain http", async () => {
    const fetchPage = vi.fn(async (url: URL) => {
      if (url.protocol === "https:") throw new SafeFetchError("connection", "refused", "ECONNREFUSED");
      return page({ finalUrl: "http://example.com/" });
    });
    const result = await analyzePresence({ website: "example.com" }, deps(fetchPage));
    expect(keys(result.signals)).toEqual(["not_https"]);
    expect(result.websiteStatus).toBe("NEEDS_WORK");
  });
});

describe("analyzePresence: HTTP responses", () => {
  it.each([404, 410])("treats HTTP %i as a verified problem", async (status) => {
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ status })));
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ key: "site_error", certainty: "VERIFIED" });
    expect(result.websiteStatus).toBe("NEEDS_WORK");
  });

  it.each([401, 403, 429, 500, 503])(
    "treats HTTP %i as uncertain, since bot filters and outages look like this",
    async (status) => {
      const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ status })));
      expect(result.signals[0]).toMatchObject({ key: "site_error", certainty: "UNCERTAIN" });
      expect(result.websiteStatus).toBe("NEEDS_CHECK");
    }
  );

  it("does not judge the markup of an error page", async () => {
    const result = await analyzePresence(
      { website: "https://example.com" },
      deps(async () => page({ status: 404, body: "<html>Not found</html>" }))
    );
    expect(keys(result.signals)).toEqual(["site_error"]);
  });

  it("does not assess a response that is not HTML", async () => {
    const result = await analyzePresence(
      { website: "https://example.com/menu.pdf" },
      deps(async () => page({ isHtml: false, contentType: "application/pdf", body: "" }))
    );
    expect(result.signals[0]).toMatchObject({ key: "site_unassessed", severity: 0, certainty: "UNCERTAIN" });
    expect(result.websiteStatus).toBe("NEEDS_CHECK");
  });
});

describe("analyzePresence: page quality signals", () => {
  it("flags a missing viewport tag and plain http as verified problems", async () => {
    const result = await analyzePresence(
      { website: "http://example.com" },
      deps(async () => page({ finalUrl: "http://example.com/", body: "<html><head></head><body>© 2026</body></html>" }))
    );
    expect(keys(result.signals).sort()).toEqual(["no_meta_description", "no_mobile_viewport", "not_https"]);
    expect(result.signals.every((s) => s.certainty === "VERIFIED")).toBe(true);
    expect(result.websiteStatus).toBe("NEEDS_WORK");
  });

  it("accepts a viewport tag whatever the attribute order", async () => {
    const body = '<head><meta content="width=device-width" name="viewport"></head>';
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body })));
    expect(keys(result.signals)).not.toContain("no_mobile_viewport");
  });

  it("does not claim a missing viewport tag from a truncated page that never reached the end of <head>", async () => {
    const body = "<html><head><title>Big page</title>" + "<!-- filler -->".repeat(100);
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body, truncated: true })));
    expect(keys(result.signals)).not.toContain("no_mobile_viewport");
  });

  it("still flags a missing viewport on a truncated page once <head> has closed", async () => {
    const body = "<html><head><title>Big page</title></head><body>" + "x".repeat(500);
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body, truncated: true })));
    expect(keys(result.signals)).toContain("no_mobile_viewport");
  });

  it("does not claim staleness from a truncated page, whose real footer was not read", async () => {
    const body = GOOD_HTML.replace("© 2026", "© 2015");
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body, truncated: true })));
    expect(keys(result.signals)).not.toContain("stale_site");
  });

  it("flags a stale copyright year", async () => {
    const body = GOOD_HTML.replace("© 2026", "© 2018");
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body })));
    expect(result.signals).toEqual([
      expect.objectContaining({ key: "stale_site", detail: "2018", certainty: "VERIFIED" }),
    ]);
    expect(result.websiteStatus).toBe("NEEDS_WORK");
  });
});

describe("analyzePresence: contact links on the business's own page", () => {
  const withLinks = GOOD_HTML.replace(
    "<body>",
    '<body><a href="mailto:info@example.com">Mail</a><a href="tel:+355691234567">Call</a>'
  );

  it("returns the page's mailto: and tel: links", async () => {
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body: withLinks })));
    expect(result.contacts).toEqual({ email: "info@example.com", phone: "+355691234567" });
  });

  it("does not read contacts from an error page, which belongs to the host", async () => {
    const result = await analyzePresence(
      { website: "https://example.com" },
      deps(async () => page({ status: 503, body: withLinks }))
    );
    expect(result.contacts).toBeUndefined();
  });

  it("has no contacts when no page was read", async () => {
    expect((await analyzePresence({ website: null }, deps(vi.fn()))).contacts).toBeUndefined();
  });
});

describe("deferWebsiteCheck", () => {
  it("records the website as unchecked: inconclusive, and worth nothing to the score", () => {
    const result = deferWebsiteCheck({ website: "example.com" }, "over the limit");
    expect(result.websiteStatus).toBe("NEEDS_CHECK");
    expect(result.signals).toEqual([
      expect.objectContaining({ key: "site_check_deferred", severity: 0, certainty: "UNCERTAIN", detail: "over the limit" }),
    ]);
  });

  it("still applies the signals that come from the listing alone", () => {
    const result = deferWebsiteCheck({ website: "example.com", reviewCount: 0, rating: 0 }, "x");
    expect(keys(result.signals)).toEqual(["site_check_deferred", "thin_listing"]);
  });
});

describe("detectStaleness", () => {
  const stale = (html: string) => detectStaleness(html, 2026);

  it("treats three or more years old as stale, two as fresh", () => {
    expect(stale("© 2023").stale).toBe(true);
    expect(stale("© 2024").stale).toBe(false);
  });

  it("uses the newest end of a year range, not the first year", () => {
    expect(stale("© 2015–2025")).toEqual({ stale: false, year: 2025 });
    expect(stale("&copy; 2015 - 2026")).toEqual({ stale: false, year: 2026 });
    expect(stale("Copyright 2010-2012")).toEqual({ stale: true, year: 2012 });
  });

  it("understands HTML entities for the copyright sign", () => {
    expect(stale("&copy; 2016 Acme")).toEqual({ stale: true, year: 2016 });
    expect(stale("&#169; 2016 Acme")).toEqual({ stale: true, year: 2016 });
  });

  it("uses the newest of several notices", () => {
    expect(stale("© 2014 Acme. Hosting © 2026 Host")).toEqual({ stale: false, year: 2026 });
  });

  it("accepts next year's footer, which sites roll over early", () => {
    expect(stale("© 2027")).toEqual({ stale: false, year: 2027 });
  });

  it("ignores implausible years and pages with no notice", () => {
    expect(stale("© 1850")).toEqual({ stale: false });
    expect(stale("© 2999")).toEqual({ stale: false });
    expect(stale("<p>no footer</p>")).toEqual({ stale: false });
  });
});

describe("listing signals", () => {
  const site = deps(async () => page());

  it("flags a listing the source reports as empty", async () => {
    const result = await analyzePresence({ website: "https://example.com", rating: 0, reviewCount: 0 }, site);
    expect(keys(result.signals)).toEqual(["thin_listing"]);
    // A thin listing says nothing about the website itself.
    expect(result.websiteStatus).toBe("GOOD");
  });

  it("does not claim 'no reviews' when the source never reports reviews at all", async () => {
    const result = await analyzePresence({ website: "https://example.com" }, site);
    expect(keys(result.signals)).not.toContain("thin_listing");
  });

  it("does not flag a listing with reviews", async () => {
    const result = await analyzePresence({ website: "https://example.com", rating: 4.5, reviewCount: 30 }, site);
    expect(result.signals).toEqual([]);
  });

  it("flags a missing website and an empty listing together", async () => {
    const result = await analyzePresence({ reviewCount: 0 }, site);
    expect(keys(result.signals)).toEqual(["no_website", "thin_listing"]);
  });
});

describe("detectGaps", () => {
  it("returns just the signals", async () => {
    const signals = await detectGaps({ website: null }, deps(vi.fn()));
    expect(keys(signals)).toEqual(["no_website"]);
  });
});

describe("analyzePresence: a website that is not a site of the business's own", () => {
  it.each([
    ["https://www.facebook.com/KlinikaArberi", "social_only"],
    ["instagram.com/klinika.arberi", "social_only"],
    ["https://linktr.ee/klinika", "social_only"],
    ["https://wa.me/355691234567", "social_only"],
    ["https://klinika-arberi.business.site", "retired_site"],
  ])("treats %s as no website, without fetching it", async (website, key) => {
    const fetchPage = vi.fn();
    const result = await analyzePresence({ website }, deps(fetchPage));
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.signals).toEqual([expect.objectContaining({ key, certainty: "VERIFIED" })]);
    expect(result.websiteStatus).toBe("NONE_FOUND");
  });

  it("does not mistake a lookalike host for a social site", async () => {
    const result = await analyzePresence({ website: "https://notfacebook.com" }, deps(async () => page()));
    expect(keys(result.signals)).not.toContain("social_only");
  });
});

describe("analyzePresence: more page checks", () => {
  const site = { website: "https://example.com" };

  it("recognises a parked or for-sale domain, and judges nothing else on it", async () => {
    const body = "<html><head></head><body>This domain is for sale! Buy this domain today.</body></html>";
    const result = await analyzePresence(site, deps(async () => page({ body, finalUrl: "http://example.com/" })));
    expect(keys(result.signals)).toEqual(["site_parked"]);
    expect(result.websiteStatus).toBe("NEEDS_WORK");
  });

  it("accepts a meta description whatever the attribute order", async () => {
    const body = GOOD_HTML.replace('<meta name="description" content="Family dentist in Tirana">', '<meta content="Family dentist" name="description">');
    const result = await analyzePresence(site, deps(async () => page({ body })));
    expect(keys(result.signals)).not.toContain("no_meta_description");
  });

  it("flags an empty meta description as missing", async () => {
    const body = GOOD_HTML.replace('content="Family dentist in Tirana"', 'content=" "');
    const result = await analyzePresence(site, deps(async () => page({ body })));
    expect(keys(result.signals)).toContain("no_meta_description");
  });

  it("flags a missing tap-to-call link only for a business with a phone", async () => {
    const withPhone = await analyzePresence({ ...site, phone: "+355 69 123 4567" }, deps(async () => page()));
    expect(keys(withPhone.signals)).toEqual(["no_tap_to_call"]);
    const withoutPhone = await analyzePresence(site, deps(async () => page()));
    expect(withoutPhone.signals).toEqual([]);
  });

  it("does not flag tap-to-call when the page has a tel: link, or was cut off", async () => {
    const linked = GOOD_HTML.replace("<body>", '<body><a href="tel:+355691234567">Call</a>');
    const phone = "+355 69 123 4567";
    expect((await analyzePresence({ ...site, phone }, deps(async () => page({ body: linked })))).signals).toEqual([]);
    const cut = await analyzePresence({ ...site, phone }, deps(async () => page({ truncated: true })));
    expect(keys(cut.signals)).not.toContain("no_tap_to_call");
  });
});

describe("analyzePresence: pages that are not the business's own", () => {
  it("reads no contacts from a parked page, whose mailto: belongs to the domain seller", async () => {
    const body = '<html><body>This domain is for sale. <a href="mailto:sales@broker.example">Contact</a></body></html>';
    const result = await analyzePresence({ website: "https://example.com" }, deps(async () => page({ body })));
    expect(keys(result.signals)).toEqual(["site_parked"]);
    expect(result.contacts).toBeUndefined();
  });

  it("treats a site that redirects to a social page as social-only, and reads nothing from it", async () => {
    const body = '<html><head></head><body><a href="mailto:noreply@facebook.example">x</a></body></html>';
    const result = await analyzePresence(
      { website: "mybiz.al", phone: "+355 69 1" },
      deps(async () => page({ body, finalUrl: "https://www.facebook.com/mybiz" }))
    );
    expect(keys(result.signals)).toEqual(["social_only"]);
    expect(result.websiteStatus).toBe("NONE_FOUND");
    expect(result.contacts).toBeUndefined();
  });
});

describe("websiteNeedsFetch", () => {
  it("is false for nothing, a social page or a retired site, and true for a real site", () => {
    expect(websiteNeedsFetch(null)).toBe(false);
    expect(websiteNeedsFetch("  ")).toBe(false);
    expect(websiteNeedsFetch("https://www.facebook.com/x")).toBe(false);
    expect(websiteNeedsFetch("klinika.business.site")).toBe(false);
    expect(websiteNeedsFetch("klinika.al")).toBe(true);
  });
});

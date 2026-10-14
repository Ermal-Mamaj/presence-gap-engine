import { describe, expect, it } from "vitest";
import { dedupeKeyFor } from "@/lib/dedupe";
import { sanitizeRawBusiness } from "@/lib/sources/validate";
import { safeHttpUrl } from "@/lib/url";

describe("dedupeKeyFor", () => {
  it("prefers the source's own id", () => {
    expect(dedupeKeyFor({ name: "A", sourceRef: "osm:node/42" })).toBe("ref:osm:node/42");
  });

  it("is stable when the same OSM element is returned twice", () => {
    const a = dedupeKeyFor({ name: "Clinic", address: "1 Main St", sourceRef: "osm:node/42" });
    const b = dedupeKeyFor({ name: "Clinic renamed", address: "elsewhere", sourceRef: "osm:node/42" });
    expect(a).toBe(b);
  });

  it("keys Google Maps places on their feature id, ignoring per-search URL data", () => {
    const first = "gmaps:https://www.google.com/maps/place/Klinika/data=!4m7!3m6!1s0x13549e:0x1f2e3d4c!8m2!3d42.2!4d20.7?entry=ttu&g_ep=AAA";
    const second = "gmaps:https://www.google.com/maps/place/Klinika/data=!4m7!3m6!1s0x13549e:0x1f2e3d4c!8m2!3d42.2!4d20.7?entry=ttu&g_ep=ZZZ";
    expect(dedupeKeyFor({ name: "Klinika", sourceRef: first })).toBe(dedupeKeyFor({ name: "Klinika", sourceRef: second }));
  });

  it("keeps different Google Maps places apart", () => {
    const a = dedupeKeyFor({ name: "A", sourceRef: "gmaps:https://x/maps/place/A/data=!1s0x1:0xa" });
    const b = dedupeKeyFor({ name: "B", sourceRef: "gmaps:https://x/maps/place/B/data=!1s0x2:0xb" });
    expect(a).not.toBe(b);
  });

  it("falls back to name and address, ignoring case, accents and punctuation", () => {
    const a = dedupeKeyFor({ name: "Dentistria Arbëri", address: "Rr. Nëna Terezë, 12" });
    const b = dedupeKeyFor({ name: "DENTISTRIA ARBERI", address: "rr nena tereze 12" });
    expect(a).toBe(b);
  });

  it("distinguishes same-named businesses at different addresses", () => {
    expect(dedupeKeyFor({ name: "Cafe", address: "1 A St" })).not.toBe(dedupeKeyFor({ name: "Cafe", address: "2 B St" }));
  });
});

describe("sanitizeRawBusiness", () => {
  it("keeps a valid record and trims text", () => {
    expect(sanitizeRawBusiness({ name: "  Clinic  ", phone: " 123 ", rating: 4.5, reviewCount: 10 })).toMatchObject({
      name: "Clinic",
      phone: "123",
      rating: 4.5,
      reviewCount: 10,
    });
  });

  it.each([null, undefined, 42, "x", [], {}, { name: "" }, { name: "   " }, { name: 5 }])("rejects %j", (raw) => {
    expect(sanitizeRawBusiness(raw)).toBeNull();
  });

  it("drops an impossible rating but keeps the business", () => {
    const result = sanitizeRawBusiness({ name: "A", rating: 47, reviewCount: 3 });
    expect(result).not.toBeNull();
    expect(result!.rating).toBeUndefined();
    expect(result!.reviewCount).toBe(3);
  });

  it("keeps a real rating of zero distinct from a missing one", () => {
    expect(sanitizeRawBusiness({ name: "A", rating: 0 })!.rating).toBe(0);
    expect(sanitizeRawBusiness({ name: "A" })!.rating).toBeUndefined();
  });

  it("drops negative, fractional and non-finite review counts", () => {
    for (const reviewCount of [-3, 2.5, NaN, Infinity]) {
      expect(sanitizeRawBusiness({ name: "A", reviewCount })!.reviewCount).toBeUndefined();
    }
    expect(sanitizeRawBusiness({ name: "A", reviewCount: 0 })!.reviewCount).toBe(0);
  });

  it("drops out-of-range coordinates", () => {
    const result = sanitizeRawBusiness({ name: "A", latitude: 200, longitude: -300 });
    expect(result!.latitude).toBeUndefined();
    expect(result!.longitude).toBeUndefined();
  });

  it("turns empty strings into unknown", () => {
    const result = sanitizeRawBusiness({ name: "A", website: "  ", phone: "", address: "" });
    expect(result).toEqual({ name: "A" });
  });

  it("normalizes contact details and drops unusable ones", () => {
    expect(
      sanitizeRawBusiness({ name: "A", email: " info@a.al; b@b.al ", facebook: "PageA", instagram: "@a.dent" })
    ).toMatchObject({
      email: "info@a.al",
      facebook: "https://www.facebook.com/PageA",
      instagram: "https://www.instagram.com/a.dent",
    });
    const bad = sanitizeRawBusiness({ name: "A", email: "nope", facebook: "https://a.al", instagram: 42 });
    expect(bad).toEqual({ name: "A" });
  });

  it("drops an absurdly long website instead of storing it", () => {
    expect(sanitizeRawBusiness({ name: "A", website: "http://x.com/" + "a".repeat(5000) })!.website).toBeUndefined();
  });
});

describe("safeHttpUrl", () => {
  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    ["ftp://example.com"],
    ["https://user:secret@example.com"],
    [""],
    [null],
    [undefined],
  ])("rejects %j", (raw) => {
    expect(safeHttpUrl(raw as string | null | undefined)).toBeNull();
  });

  it("accepts http and https links", () => {
    expect(safeHttpUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  it("assumes https for a bare domain", () => {
    expect(safeHttpUrl("example.com")).toBe("https://example.com/");
    expect(safeHttpUrl("www.example.com/menu")).toBe("https://www.example.com/menu");
  });
});

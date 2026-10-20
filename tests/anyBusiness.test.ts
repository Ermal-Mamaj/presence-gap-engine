import { describe, expect, it } from "vitest";
import { ANY_BUSINESS_SEARCHES, ANY_BUSINESS_TAGS, isAnyBusiness } from "@/lib/sources/anyBusiness";
import { mergeListings, placeKey, searchPlan } from "@/lib/sources/googleMapsScraper";
import { buildOverpassQuery, tagsForNiche } from "@/lib/sources/osm";

describe("isAnyBusiness", () => {
  it.each(["Anything", " anything ", "ANY BUSINESS", "all", "*", "Çdo biznes", "të gjitha"])("%s means any business", (niche) => {
    expect(isAnyBusiness(niche)).toBe(true);
  });

  it.each(["dentist", "car repair", "anything goes", ""])("%s is one type, or none", (niche) => {
    expect(isAnyBusiness(niche)).toBe(false);
  });
});

describe("Google Maps: searching for anything", () => {
  it("searches each common type in the region, a few places each", () => {
    // Found live: "Anything in Suharek, Kosovo" went to Google as typed and found 7 places.
    const plan = searchPlan("Anything", "Suharek, Kosovo");
    expect(plan.queries).toHaveLength(ANY_BUSINESS_SEARCHES.length);
    expect(plan.queries).toContain("restaurant in Suharek, Kosovo");
    expect(plan.queries).toContain("car repair in Suharek, Kosovo");
    expect(plan.queries.some((q) => /anything/i.test(q))).toBe(false);
    expect(plan.perQuery).toBeLessThan(plan.total);
  });

  it("still runs one search for one type, capped as before", () => {
    expect(searchPlan("dentist", "Tirana", 25)).toEqual({ queries: ["dentist in Tirana"], perQuery: 25, total: 25 });
    expect(searchPlan("dentist", "Tirana", 500).total).toBe(40);
  });

  it("knows a place by its Maps feature id, whichever search found it", () => {
    const a = "https://www.google.com/maps/place/Troi/data=!4m7!3m6!1s0x1353a1:0xABC!8m2!3d42.3!4d20.8?authuser=0&hl=en&rclk=1";
    const b = "https://www.google.com/maps/place/Troi+Restaurant/data=!4m10!1s0x1353a1:0xabc!5m2?hl=sq";
    expect(placeKey(a)).toBe(placeKey(b));
    expect(placeKey("https://www.google.com/maps/place/X?hl=en")).toBe("https://www.google.com/maps/place/X");
  });

  it("takes places from each search in turn, each once, up to the cap", () => {
    const l = (name: string, id: string) => ({ name, href: `https://www.google.com/maps/place/${name}/data=!1s0x1:0x${id}` });
    const restaurants = [l("Troi", "1"), l("Suare", "2"), l("Era", "3")];
    const cafes = [l("Soho", "4"), l("Troi", "1"), l("Rozi", "5")]; // Troi is a café too
    const garages = [l("Cadraki", "6")];
    expect(mergeListings([restaurants, cafes, garages], 10).map((p) => p.name)).toEqual(["Troi", "Soho", "Cadraki", "Suare", "Era", "Rozi"]);
    expect(mergeListings([restaurants, cafes, garages], 4).map((p) => p.name)).toEqual(["Troi", "Soho", "Cadraki", "Suare"]);
  });
});

describe("OpenStreetMap: searching for anything", () => {
  it("asks for every named shop, craft and office, and the amenities worth a pitch", () => {
    expect(tagsForNiche("anything")).toEqual(ANY_BUSINESS_TAGS);
    const query = buildOverpassQuery(["42.32", "42.40", "20.79", "20.87"], ["shop=*", "amenity=cafe"], 400);
    expect(query).toContain('node["shop"]["name"](42.32,20.79,42.40,20.87);');
    expect(query).toContain('node["amenity"="cafe"](42.32,20.79,42.40,20.87);');
    expect(query).toContain("out center tags 400;");
  });

  it("still takes one type, or tags given directly", () => {
    expect(tagsForNiche("dentist")).toEqual(["amenity=dentist"]);
    expect(tagsForNiche("shop=optician")).toEqual(["shop=optician"]);
    expect(buildOverpassQuery(["1", "2", "3", "4"], ["amenity=dentist"])).toContain("out center tags 200;");
  });
});

describe("OpenStreetMap: the heavy query", () => {
  it("asks the server for no longer than the client waits for it", () => {
    // The client gives up on an Overpass attempt after 40s; a longer server timeout only wastes the attempt.
    const query = buildOverpassQuery(["1", "2", "3", "4"], ["shop=*"], 400);
    expect(query).toContain("[timeout:40]");
  });
});

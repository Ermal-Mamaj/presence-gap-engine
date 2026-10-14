import { describe, expect, it } from "vitest";
import { elementToBusiness } from "@/lib/sources/osm";
import { sanitizeRawBusiness } from "@/lib/sources/validate";

const node = (tags: Record<string, string>) => ({ type: "node", id: 7, lat: 41.33, lon: 19.82, tags });

describe("elementToBusiness", () => {
  it("skips an element without a name", () => {
    expect(elementToBusiness(node({ amenity: "dentist" }))).toBeNull();
  });

  it("reads contact details under either OSM spelling", () => {
    const plain = elementToBusiness(
      node({ name: "A", phone: "+355 1", email: "a@a.al", facebook: "PageA", instagram: "a.dent" })
    );
    const prefixed = elementToBusiness(
      node({
        name: "A",
        "contact:phone": "+355 1",
        "contact:email": "a@a.al",
        "contact:facebook": "PageA",
        "contact:instagram": "a.dent",
      })
    );
    const expected = { phone: "+355 1", email: "a@a.al", facebook: "PageA", instagram: "a.dent" };
    expect(plain).toMatchObject(expected);
    expect(prefixed).toMatchObject(expected);
  });

  it("falls back to a mobile number when there is no phone", () => {
    expect(elementToBusiness(node({ name: "A", "contact:mobile": "+355 69 1" }))?.phone).toBe("+355 69 1");
  });

  it("leaves normalization to sanitizeRawBusiness, which every source goes through", () => {
    const raw = elementToBusiness(node({ name: "A", email: "bad; a@a.al", facebook: "https://m.facebook.com/PageA/" }));
    expect(sanitizeRawBusiness(raw)).toMatchObject({
      email: "a@a.al",
      facebook: "https://www.facebook.com/PageA",
    });
  });
});

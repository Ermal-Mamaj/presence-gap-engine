import { describe, expect, it } from "vitest";
import {
  contactChannels,
  extractSiteContacts,
  normalizeEmail,
  normalizePhone,
  normalizeSocialUrl,
} from "@/lib/contacts";

describe("normalizeEmail", () => {
  it("keeps a plain address", () => {
    expect(normalizeEmail("info@klinika.al")).toBe("info@klinika.al");
  });

  it("takes the first usable address from a field that lists several", () => {
    // OSM allows "a; b" in one tag.
    expect(normalizeEmail("info@klinika.al; dr.berisha@gmail.com")).toBe("info@klinika.al");
    expect(normalizeEmail("not-an-email, info@klinika.al")).toBe("info@klinika.al");
  });

  it("strips a mailto: prefix and its query", () => {
    expect(normalizeEmail("mailto:info@klinika.al?subject=Hello")).toBe("info@klinika.al");
  });

  it.each([
    [""],
    ["   "],
    ["info at klinika dot al"],
    ["info@klinika"],
    ["@klinika.al"],
    ["info@@klinika.al"],
    ['info@klinika.al"><script>'],
    [null],
    [undefined],
  ])("drops %j", (raw) => {
    expect(normalizeEmail(raw as string | null | undefined)).toBeUndefined();
  });
});

describe("normalizePhone", () => {
  it("keeps a formatted number", () => {
    expect(normalizePhone("+355 69 123 4567")).toBe("+355 69 123 4567");
    expect(normalizePhone("(044) 123-456")).toBe("(044) 123-456");
  });

  it("strips a tel: prefix", () => {
    expect(normalizePhone("tel:+355691234567")).toBe("+355691234567");
  });

  it.each([["12345"], ["call us"], ["+355 69 123 4567; +355 4 222 333"], ["javascript:alert(1)"], [""], [null]])(
    "drops %j",
    (raw) => {
      expect(normalizePhone(raw as string | null)).toBeUndefined();
    }
  );
});

describe("normalizeSocialUrl", () => {
  it("canonicalizes a profile link", () => {
    expect(normalizeSocialUrl("https://m.facebook.com/KlinikaDentare/", "facebook")).toBe(
      "https://www.facebook.com/KlinikaDentare"
    );
    expect(normalizeSocialUrl("instagram.com/klinika.dentare?igsh=abc", "instagram")).toBe(
      "https://www.instagram.com/klinika.dentare"
    );
  });

  it("turns a bare page name or handle into a profile link", () => {
    expect(normalizeSocialUrl("KlinikaDentare", "facebook")).toBe("https://www.facebook.com/KlinikaDentare");
    expect(normalizeSocialUrl("@klinika.dentare", "instagram")).toBe("https://www.instagram.com/klinika.dentare");
  });

  it("keeps the id of a profile.php page, which lives in the query", () => {
    expect(normalizeSocialUrl("https://www.facebook.com/profile.php?id=100064", "facebook")).toBe(
      "https://www.facebook.com/profile.php?id=100064"
    );
  });

  it("drops a link to another host instead of rewriting it", () => {
    expect(normalizeSocialUrl("https://klinika.al", "facebook")).toBeUndefined();
    expect(normalizeSocialUrl("https://facebook.com.evil.example/page", "facebook")).toBeUndefined();
    expect(normalizeSocialUrl("https://www.facebook.com/klinika", "instagram")).toBeUndefined();
  });

  it.each([
    ["https://www.facebook.com/"],
    ["https://www.facebook.com/sharer/sharer.php?u=x"],
    ["https://www.facebook.com/plugins/page.php"],
    ["https://www.facebook.com/tr?id=1"],
    ["javascript:alert(1)//facebook.com/x"],
    ["https://user:pw@facebook.com/x"],
    ["two words"],
  ])("drops %j, which is not a profile", (raw) => {
    expect(normalizeSocialUrl(raw, "facebook")).toBeUndefined();
  });
});

describe("extractSiteContacts", () => {
  it("reads the first mailto: and tel: links", () => {
    const html = `
      <a href="mailto:info@klinika.al">Email us</a>
      <a href='tel:+355 69 123 4567'>Call</a>
      <a href="mailto:second@klinika.al">Other</a>`;
    expect(extractSiteContacts(html)).toEqual({ email: "info@klinika.al", phone: "+355 69 123 4567" });
  });

  it("decodes the common obfuscations of an address", () => {
    expect(extractSiteContacts('<a href="mailto:info%40klinika.al">x</a>').email).toBe("info@klinika.al");
    expect(extractSiteContacts('<a href="mailto:info&#64;klinika.al">x</a>').email).toBe("info@klinika.al");
  });

  it("skips an unusable link and keeps looking", () => {
    const html = '<a href="mailto:">x</a><a href="mailto:info@klinika.al">y</a>';
    expect(extractSiteContacts(html).email).toBe("info@klinika.al");
  });

  it("finds nothing in a page without contact links", () => {
    expect(extractSiteContacts("<p>Write to info@klinika.al</p>")).toEqual({});
  });
});

describe("contactChannels", () => {
  it("counts phone, email and social once each", () => {
    expect(
      contactChannels({ phone: "1", email: "a@b.co", facebook: "https://www.facebook.com/x", instagram: "https://www.instagram.com/x" })
    ).toEqual(["phone", "email", "social"]);
  });

  it("treats blank values as missing", () => {
    expect(contactChannels({ phone: "  ", email: null })).toEqual([]);
  });
});

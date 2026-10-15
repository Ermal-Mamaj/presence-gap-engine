import { describe, expect, it } from "vitest";
import { defaultChannel, isDraftChannel, isDraftLanguage } from "@/lib/outreachOptions";

describe("defaultChannel", () => {
  it("prefers email, which carries a written pitch best", () => {
    expect(defaultChannel({ email: "a@b.al", phone: "1", facebook: "https://www.facebook.com/a" })).toBe("email");
  });

  it("falls back to a message when there is a social profile", () => {
    expect(defaultChannel({ phone: "1", instagram: "https://www.instagram.com/a" })).toBe("message");
  });

  it("falls back to a call script when there is only a phone", () => {
    expect(defaultChannel({ phone: "+355 69 1" })).toBe("phone");
  });

  it("drafts an email when there is no way to reach the lead yet", () => {
    expect(defaultChannel({})).toBe("email");
  });
});

describe("option guards", () => {
  it("accepts only the listed languages and channels", () => {
    expect(isDraftLanguage("sq")).toBe(true);
    expect(isDraftLanguage("xx")).toBe(false);
    // Inherited object keys are not languages.
    expect(isDraftLanguage("toString")).toBe(false);
    expect(isDraftChannel("phone")).toBe(true);
    expect(isDraftChannel("fax")).toBe(false);
  });
});

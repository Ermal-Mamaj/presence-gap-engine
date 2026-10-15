import { describe, expect, it } from "vitest";
import { fillTemplate, isTemplateGap, placeholdersIn, templateProblems } from "@/lib/templateText";

const values = { name: "Klinika Arbëri", business_type: "dentist", area: "Tirana", website: null };

describe("fillTemplate", () => {
  it("fills every placeholder, spaces inside the braces allowed", () => {
    expect(fillTemplate("Përshëndetje {{name}}, {{ business_type }} në {{area}}.", values)).toBe(
      "Përshëndetje Klinika Arbëri, dentist në Tirana."
    );
  });

  it("refuses to fill a template that needs a value the lead doesn't have", () => {
    expect(fillTemplate("Your site {{website}} is slow", values)).toBeNull();
    expect(fillTemplate("Hello {{name}}", { ...values, name: "  " })).toBeNull();
  });

  it("leaves text without placeholders as written", () => {
    expect(fillTemplate("No placeholders here.", values)).toBe("No placeholders here.");
  });
});

describe("templateProblems", () => {
  it("accepts a well-formed template", () => {
    expect(templateProblems("For {{name}}", "Hello {{name}} in {{area}}")).toEqual([]);
  });

  it("names unknown placeholders and lists the ones that exist", () => {
    const [problem] = templateProblems(null, "Hi {{owner}}, about {{city}}");
    expect(problem).toContain("{{owner}}, {{city}}");
    expect(problem).toContain("{{name}}");
  });

  it.each(["Hello {{name}", "Hello {name}}", "Hello {{ name", "Hi }} there"])("catches a malformed placeholder in %j", (body) => {
    expect(templateProblems(null, body).join(" ")).toContain("not written correctly");
  });
});

describe("helpers", () => {
  it("lists each placeholder once", () => {
    expect(placeholdersIn("{{name}} {{name}} {{area}}")).toEqual(["name", "area"]);
  });

  it("knows only verified gaps, never an uncertain one", () => {
    expect(isTemplateGap("no_website")).toBe(true);
    expect(isTemplateGap("site_unreachable")).toBe(false);
    expect(isTemplateGap("toString")).toBe(false);
  });
});

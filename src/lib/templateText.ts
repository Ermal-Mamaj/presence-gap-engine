/**
 * The parts of message templates that need no database: which gaps a
 * template can be written for, which placeholders it may use, and filling
 * them in. Kept apart from src/lib/templates.ts so the editor page can
 * validate and preview in the browser with the same code the server uses.
 */

/**
 * The gaps a draft may state, with what each means. These are the signals a
 * scan records as VERIFIED with a weight (see citableSignals): an uncertain
 * one is never put to a business as fact, so there is no template for it.
 */
export const TEMPLATE_GAPS = {
  no_website: "The listing has no website",
  social_only: "Uses a social media page instead of a website",
  retired_site: "Website was a Google Business Profile site, shut down in 2024",
  site_parked: "Website domain is parked or for sale",
  site_error: "Website page is missing (HTTP 404 or 410)",
  not_https: "Site is not served over HTTPS",
  no_mobile_viewport: "Site is not built for phones (no mobile viewport)",
  stale_site: "Site looks stale (old copyright year)",
  no_meta_description: "Site gives search engines no description",
  no_tap_to_call: "Phone number can't be tapped to call",
  thin_listing: "Few or no online reviews",
} as const;

export type TemplateGap = keyof typeof TEMPLATE_GAPS;

export function isTemplateGap(value: unknown): value is TemplateGap {
  return typeof value === "string" && Object.hasOwn(TEMPLATE_GAPS, value);
}

/** What a template may ask for, and where the value comes from. */
export const PLACEHOLDERS = {
  name: "The business's name",
  business_type: "The campaign's business type, e.g. dentist",
  area: "The campaign's region, e.g. Tirana",
  website: "The business's website, when it has one",
} as const;

export type Placeholder = keyof typeof PLACEHOLDERS;
export type PlaceholderValues = Partial<Record<Placeholder, string | null | undefined>>;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Every placeholder name a text uses, known or not. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/** Problems that make a template unusable, in words the editor can show. */
export function templateProblems(subject: string | null | undefined, body: string): string[] {
  const problems: string[] = [];
  const unknown = placeholdersIn(`${subject ?? ""}\n${body}`).filter((p) => !Object.hasOwn(PLACEHOLDERS, p));
  if (unknown.length) {
    problems.push(
      `Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown.map((p) => `{{${p}}}`).join(", ")}. ` +
        `Use ${Object.keys(PLACEHOLDERS).map((p) => `{{${p}}}`).join(", ")}.`
    );
  }
  // Every {{ and }} should belong to a well-formed placeholder; a stray one is
  // almost always a typo, and would reach the business as written.
  const text = `${subject ?? ""}\n${body}`;
  const wellFormed = [...text.matchAll(PLACEHOLDER)].length;
  const opens = text.split("{{").length - 1;
  const closes = text.split("}}").length - 1;
  if (opens !== wellFormed || closes !== wellFormed) {
    problems.push("A placeholder is not written correctly: use the form {{name}}.");
  }
  return problems;
}

/**
 * The text with its placeholders filled in, or null when it needs a value
 * this lead doesn't have (a {{website}} for a business with none): a
 * template that would leave a hole is skipped, never sent half-filled.
 */
export function fillTemplate(text: string, values: PlaceholderValues): string | null {
  let missing = false;
  const filled = text.replace(PLACEHOLDER, (_, key: string) => {
    const value = Object.hasOwn(PLACEHOLDERS, key) ? values[key as Placeholder]?.trim() : undefined;
    if (!value) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? null : filled;
}

/**
 * Contact details from third-party data, normalized to something a person can
 * act on, or dropped. OSM contact tags are free text: an email tag can hold two
 * addresses, a facebook tag a full URL or a bare page name. Same posture as
 * src/lib/url.ts: these values reach mailto: and href attributes, so anything
 * that doesn't parse cleanly is discarded rather than repaired.
 */

// Deliberately plain: the usual local-part characters, one @, a dotted domain.
// Anything stranger is more likely a typo or an obfuscation than an inbox.
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** The first usable address in a field that may list several. */
export function normalizeEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  for (const part of raw.split(/[;,\s]+/)) {
    const candidate = part.replace(/^mailto:/i, "").split("?")[0];
    if (candidate.length <= 254 && EMAIL.test(candidate)) return candidate;
  }
  return undefined;
}

/** A dialable number: digits and the usual separators, and enough digits to be real. */
export function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.replace(/^tel:/i, "").trim();
  if (value.length > 60 || !/^\+?[\d\s().\-/]+$/.test(value)) return undefined;
  return (value.match(/\d/g)?.length ?? 0) >= 6 ? value : undefined;
}

export type SocialNetwork = "facebook" | "instagram";

const SOCIAL: Record<SocialNetwork, { canonicalHost: string; hosts: string[] }> = {
  facebook: { canonicalHost: "www.facebook.com", hosts: ["facebook.com", "fb.com"] },
  instagram: { canonicalHost: "www.instagram.com", hosts: ["instagram.com"] },
};

// Links that sit on a social host without being anyone's page: share buttons,
// embeds, the tracking pixel, login walls.
const NOT_A_PROFILE = /^\/(?:sharer|share|plugins|dialog|tr|login|intent|accounts)(?:[/.?]|$)/i;

const HANDLE = /^@?([A-Za-z0-9._-]{1,100})$/;

/**
 * A canonical profile URL for a page name, handle or link on that network.
 * A link to another host is dropped, not rewritten: "facebook" tagged with a
 * website is a mistake in the data, not a Facebook page.
 */
export function normalizeSocialUrl(raw: string | null | undefined, network: SocialNetwork): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const { canonicalHost, hosts } = SOCIAL[network];

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!hasScheme && !value.includes("/")) {
    const handle = value.match(HANDLE)?.[1];
    return handle ? `https://${canonicalHost}/${handle}` : undefined;
  }

  let url: URL;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return undefined;

  const path = url.pathname.replace(/\/+$/, "");
  if (!path || NOT_A_PROFILE.test(path)) return undefined;
  // profile.php identifies the page by query string; everywhere else the query
  // is tracking noise.
  const query = path === "/profile.php" ? url.search : "";
  return `https://${canonicalHost}${path}${query}`;
}

export interface SiteContacts {
  email?: string;
  phone?: string;
}

function decodeHref(value: string): string {
  const unescaped = value.replace(/&#0*64;|&#x0*40;/gi, "@").replace(/&amp;/gi, "&");
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

function firstUsable(html: string, pattern: RegExp, normalize: (raw: string) => string | undefined) {
  for (const match of html.matchAll(pattern)) {
    const value = normalize(decodeHref(match[1]));
    if (value) return value;
  }
  return undefined;
}

/**
 * The first mailto: and tel: links on a page the business publishes itself.
 * Read from markup only; nothing on the page is executed or followed.
 */
export function extractSiteContacts(html: string): SiteContacts {
  const contacts: SiteContacts = {};
  const email = firstUsable(html, /href\s*=\s*["']?\s*mailto:([^"'\s>]+)/gi, normalizeEmail);
  const phone = firstUsable(html, /href\s*=\s*["']?\s*tel:([^"'>]+)/gi, normalizePhone);
  if (email) contacts.email = email;
  if (phone) contacts.phone = phone;
  return contacts;
}

export type ContactChannel = "phone" | "email" | "social";

/** Whether the lead can be reached at all, and how many distinct ways. */
export function contactChannels(business: {
  phone?: string | null;
  email?: string | null;
  facebook?: string | null;
  instagram?: string | null;
}): ContactChannel[] {
  const has = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";
  const channels: ContactChannel[] = [];
  if (has(business.phone)) channels.push("phone");
  if (has(business.email)) channels.push("email");
  if (has(business.facebook) || has(business.instagram)) channels.push("social");
  return channels;
}

/**
 * Returns the URL only when it is a plain http(s) link, otherwise null. Business
 * websites come from third-party data (anyone can edit an OSM tag), so they must
 * never reach an href unchecked: "javascript:" and "data:" links would execute
 * in the viewer's browser.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

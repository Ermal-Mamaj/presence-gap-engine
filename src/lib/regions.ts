/**
 * A campaign's region may name several places, separated by semicolons:
 * "Suharekë, Kosovo; Rahovec, Kosovo; Malishevë, Kosovo". A comma stays part
 * of one place's name ("Suharekë, Kosovo"), so it can't be the separator.
 * Pure, so the form and the server read a region the same way.
 */

/** Each place is a separate search, so a scan of N places takes about N times as long. */
export const MAX_PLACES = 5;

const key = (place: string) =>
  place
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

/** The places a region names, in order, each once however it is spelled. Never empty for a non-blank region. */
export function splitRegions(region: string): string[] {
  const seen = new Set<string>();
  const places: string[] = [];
  for (const part of region.split(/[;\n]/)) {
    const place = part.trim().replace(/\s+/g, " ");
    if (place && !seen.has(key(place))) {
      seen.add(key(place));
      places.push(place);
    }
  }
  return places;
}

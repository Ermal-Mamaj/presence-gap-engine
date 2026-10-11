/**
 * CSV serialization for lead exports.
 *
 * Two separate concerns, both because the rows are third-party data. RFC 4180
 * quoting, so a comma or newline in a business name can't shift every later
 * column. And a formula guard, because the export exists to be opened in Excel
 * or Sheets: a cell beginning "=", "+", "-" or "@" is read as a formula there,
 * and OSM fields are editable by anyone. Same posture as src/lib/safeFetch.ts
 * and src/lib/url.ts — treat the source as hostile.
 */

export type CsvValue = string | number | Date | null | undefined;

// Leading characters a spreadsheet may read as the start of a formula.
// Tab and CR matter because a spreadsheet strips them before parsing.
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/** Quotes and neutralizes one field. Numbers are emitted bare. */
export function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";

  // An apostrophe is how a spreadsheet marks a cell as literal text. It is a
  // formatting marker rather than displayed content, so "+355 69" still reads
  // as "+355 69" while "=cmd|..." can no longer execute.
  let text: string = FORMULA_PREFIXES.some((p) => value.startsWith(p)) ? `'${value}` : value;

  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One CSV document, CRLF-delimited per RFC 4180. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((cells) => cells.map(escapeCsvField).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * A safe download filename built from a campaign name. The name is user input
 * and lands in a Content-Disposition header, so anything that could close the
 * quoted string or inject a header is dropped rather than escaped.
 */
export function csvFilename(campaignName: string, suffix = "leads"): string {
  const slug = campaignName
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "campaign"}-${suffix}.csv`;
}

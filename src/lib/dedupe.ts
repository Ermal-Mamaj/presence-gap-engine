import type { RawBusiness } from "./sources/types";

function normalizeText(value: string | undefined | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Google Maps place URLs embed a stable feature id ("!1s0x...:0x...") next to
// per-search tracking data. Keying on the whole URL would make every rerun look
// like a new business.
export function stableSourceRef(sourceRef: string): string {
  if (sourceRef.startsWith("gmaps:")) {
    const featureId = sourceRef.match(/!1s([^!?&/]+)/)?.[1];
    if (featureId) return `gmaps:${featureId}`;
  }
  return sourceRef;
}

/**
 * Identity of a business within one campaign, stable across reruns. Prefers the
 * source's own id; falls back to normalized name + address, so formatting and
 * accent differences don't create duplicates.
 */
export function dedupeKeyFor(raw: Pick<RawBusiness, "name" | "address" | "sourceRef">): string {
  if (raw.sourceRef) return `ref:${stableSourceRef(raw.sourceRef)}`;
  return `nm:${normalizeText(raw.name)}|${normalizeText(raw.address)}`;
}

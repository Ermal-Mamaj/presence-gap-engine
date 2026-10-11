// Shared presentation strings for scan-derived state.
//
// These live in one place because the campaign table and the lead page must
// not describe the same status differently. The wording is deliberate: a scan
// records what it could prove, and the UI must not imply more than that.

import type { WebsiteStatus } from "./detect";

/**
 * NONE_FOUND means *the listing* has no website, not that the business has
 * none — OpenStreetMap omits plenty that exist. NEEDS_CHECK means a check
 * failed, so nothing was established either way; it is not a verdict of "bad".
 */
export const WEBSITE_STATUS_LABEL: Record<WebsiteStatus, string> = {
  NONE_FOUND: "None listed",
  NEEDS_WORK: "Needs work",
  NEEDS_CHECK: "Inconclusive",
  GOOD: "Looks fine",
};

export const WEBSITE_STATUS_HINT: Record<WebsiteStatus, string> = {
  NONE_FOUND: "The listing has no website. The business may still have one — worth checking by hand.",
  NEEDS_WORK: "Verified problems were found on the site.",
  NEEDS_CHECK: "A check failed, so nothing is proven either way. Worth a manual look.",
  GOOD: "No problems were detected on the site.",
};

export const WEBSITE_STATUS_STYLE: Record<WebsiteStatus, string> = {
  NONE_FOUND: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  NEEDS_WORK: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  NEEDS_CHECK: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  GOOD: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

export const SCAN_STATUS_STYLE: Record<string, string> = {
  RUNNING: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  SUCCEEDED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

/** A compact absolute timestamp; scan history is read for sequence, not prose. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Whole seconds, or "—" when a run never finished. */
export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "<1s";
  return `${Math.round(ms / 1000)}s`;
}

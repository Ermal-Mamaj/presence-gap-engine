"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { contactChannels } from "@/lib/contacts";
import { CRM_STAGES } from "@/lib/crm";
import type { WebsiteStatus } from "@/lib/detect";
import {
  formatDuration,
  formatTimestamp,
  SCAN_STATUS_STYLE,
  WEBSITE_STATUS_HINT,
  WEBSITE_STATUS_LABEL,
  WEBSITE_STATUS_STYLE,
} from "@/lib/display";

const WEBSITE_STATUSES: WebsiteStatus[] = ["NONE_FOUND", "NEEDS_WORK", "NEEDS_CHECK", "GOOD"];
type SortKey = "score" | "name";

/** How often to re-read a campaign while its scan is running. */
const SCAN_POLL_MS = 2000;

const CONTROL_CLASS =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";

interface GapSignal {
  id: string;
  key: string;
  label: string;
  severity: number;
  certainty: string;
}

interface Business {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  facebook: string | null;
  instagram: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  score: number;
  crmStage: string;
  websiteStatus: WebsiteStatus;
  lastSeenAt: string;
  signals: GapSignal[];
}

type ContactFilter = "ALL" | "REACHABLE" | "EMAIL" | "NONE";

/** Short labels for the contact column, with the values themselves as tooltips. */
function contactSummary(b: Business): { label: string; value: string }[] {
  return [
    b.email && { label: "Email", value: b.email },
    b.phone && { label: "Phone", value: b.phone },
    b.facebook && { label: "Facebook", value: b.facebook },
    b.instagram && { label: "Instagram", value: b.instagram },
  ].filter((c): c is { label: string; value: string } => Boolean(c));
}

interface ScanRun {
  id: string;
  status: string;
  errorMessage: string | null;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  deferred: number;
  startedAt: string;
  finishedAt: string | null;
}

interface Campaign {
  id: string;
  name: string;
  region: string;
  niche: string;
  source: string;
  status: string;
  errorMessage: string | null;
  businesses: Business[];
  scans: ScanRun[];
}

const STAGE_STYLES: Record<string, string> = {
  NEW: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  QUALIFIED: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  CONTACTED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  REPLIED: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  CONVERTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  DELIVERED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  RETAINED: "bg-emerald-200 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200",
  DEAD: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string>("ALL");
  const [siteFilter, setSiteFilter] = useState<string>("ALL");
  const [contactFilter, setContactFilter] = useState<ContactFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("score");

  // Promise callbacks rather than async/await: state must not be set on the
  // effect's synchronous path (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    return fetch(`/api/campaigns/${id}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Could not load this campaign");
        return data as Campaign;
      })
      .then((data) => {
        setCampaign(data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Could not load this campaign");
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // The scan outlives the request that started it, so its result arrives by
  // polling rather than in the POST response. Watch until the campaign leaves
  // RUNNING; returning to that state later simply restarts this.
  useEffect(() => {
    if (campaign?.status !== "RUNNING") return;
    const timer = setInterval(load, SCAN_POLL_MS);
    return () => clearInterval(timer);
  }, [campaign?.status, load]);

  const latestScan = campaign?.scans?.[0] ?? null;
  const scanning = campaign?.status === "RUNNING";

  /**
   * A lead last seen before the most recent successful scan started was not
   * returned by that scan. Scans never delete leads, so flagging it here is
   * the only way a listing that disappeared becomes visible at all.
   */
  const lastGoodScanAt = useMemo(() => {
    const succeeded = campaign?.scans?.find((s) => s.status === "SUCCEEDED");
    return succeeded ? new Date(succeeded.startedAt).getTime() : null;
  }, [campaign?.scans]);

  function isStale(business: Business): boolean {
    if (lastGoodScanAt === null) return false;
    return new Date(business.lastSeenAt).getTime() < lastGoodScanAt;
  }

  // Filtering and sorting are client-side: a campaign holds tens of leads, all
  // of which are already on the page, so a round trip would only add latency.
  const visible = useMemo(() => {
    const matchesContact = (b: Business) => {
      if (contactFilter === "ALL") return true;
      if (contactFilter === "EMAIL") return Boolean(b.email);
      const reachable = contactChannels(b).length > 0;
      return contactFilter === "REACHABLE" ? reachable : !reachable;
    };
    const rows = (campaign?.businesses ?? []).filter(
      (b) =>
        (stageFilter === "ALL" || b.crmStage === stageFilter) &&
        (siteFilter === "ALL" || b.websiteStatus === siteFilter) &&
        matchesContact(b)
    );
    return rows.sort((a, b) =>
      sortKey === "name" ? a.name.localeCompare(b.name) : b.score - a.score
    );
  }, [campaign?.businesses, stageFilter, siteFilter, contactFilter, sortKey]);

  const filtering = stageFilter !== "ALL" || siteFilter !== "ALL" || contactFilter !== "ALL";

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/run`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Run failed");
      // 202 Accepted: the scan has started, not finished. Reload so the
      // campaign reads RUNNING, which starts the poll above.
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      // A failed or refused run leaves saved leads intact; show their current state.
      await load();
    } finally {
      setRunning(false);
    }
  }

  if (!campaign) {
    return (
      <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
          {loadError ? (
            <>
              <Link href="/" className="text-sm text-zinc-500 hover:underline">
                ← All campaigns
              </Link>
              <p className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
                {loadError}
              </p>
              <button
                onClick={load}
                className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Try again
              </button>
            </>
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← All campaigns
        </Link>

        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{campaign.name}</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {campaign.niche} in {campaign.region} · source: {campaign.source}
            </p>
          </div>
          <button
            onClick={handleRun}
            disabled={running || campaign.status === "RUNNING"}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {running || campaign.status === "RUNNING" ? "Running…" : campaign.businesses.length ? "Re-run" : "Run pipeline"}
          </button>
        </div>

        {campaign.status === "FAILED" && campaign.errorMessage && (
          <div className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            <p>{campaign.errorMessage}</p>
            {campaign.businesses.length > 0 && (
              <p className="mt-1 text-red-600 dark:text-red-400">
                The leads below are from the last good scan and were not affected.
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </p>
        )}

        {scanning ? (
          <div className="mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            <p>
              Scanning since {formatTimestamp(latestScan?.startedAt)}. Checking each website takes a few
              seconds, so a large campaign can run for minutes.
            </p>
            {/* The scan no longer depends on this request, so saying so is
                accurate as well as reassuring. */}
            <p className="mt-1 text-amber-700 dark:text-amber-400">
              It runs on the server — you can leave this page and come back. Any leads below are from the
              last scan and stay untouched until this one finishes.
            </p>
          </div>
        ) : (
          latestScan && (
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
              Last scan {formatTimestamp(latestScan.startedAt)} ·{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{latestScan.found} found</span>,{" "}
              {latestScan.created} new, {latestScan.updated} refreshed
              {latestScan.skipped > 0 && (
                <span title="Records with no usable name, or duplicates of another record in the same batch.">
                  , {latestScan.skipped} skipped
                </span>
              )}
              {latestScan.deferred > 0 && (
                <span title="Every lead was saved. These websites were over the per-scan check limit; the next scan checks them first.">
                  , {latestScan.deferred} website{latestScan.deferred === 1 ? "" : "s"} left for the next scan
                </span>
              )}
            </p>
          )
        )}

        {campaign.businesses.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500">No leads yet. Run the pipeline to find and score businesses.</p>
          </div>
        ) : (
          <>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <label htmlFor="stage-filter" className="sr-only">
                Filter by stage
              </label>
              <select
                id="stage-filter"
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                className={CONTROL_CLASS}
              >
                <option value="ALL">All stages</option>
                {CRM_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              <label htmlFor="site-filter" className="sr-only">
                Filter by site status
              </label>
              <select
                id="site-filter"
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className={CONTROL_CLASS}
              >
                <option value="ALL">Any site status</option>
                {WEBSITE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {WEBSITE_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>

              <label htmlFor="contact-filter" className="sr-only">
                Filter by contact details
              </label>
              <select
                id="contact-filter"
                value={contactFilter}
                onChange={(e) => setContactFilter(e.target.value as ContactFilter)}
                className={CONTROL_CLASS}
              >
                <option value="ALL">Any contact details</option>
                <option value="REACHABLE">Can be contacted</option>
                <option value="EMAIL">Has an email</option>
                <option value="NONE">No contact found</option>
              </select>

              <label htmlFor="sort-key" className="sr-only">
                Sort
              </label>
              <select
                id="sort-key"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className={CONTROL_CLASS}
              >
                <option value="score">Highest score</option>
                <option value="name">Name A–Z</option>
              </select>

              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {filtering
                  ? `${visible.length} of ${campaign.businesses.length} leads`
                  : `${campaign.businesses.length} leads`}
              </span>

              {/* Exports the whole campaign, not the filtered view — said plainly
                  here so the two can't quietly disagree. */}
              <a
                href={`/api/campaigns/${id}/export`}
                title="Downloads every lead in this campaign, ignoring the filters above."
                className="ml-auto rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Export all as CSV
              </a>
            </div>

            {visible.length === 0 ? (
              <div className="mt-4 rounded-lg border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-500">No leads match these filters.</p>
                <button
                  onClick={() => {
                    setStageFilter("ALL");
                    setSiteFilter("ALL");
                    setContactFilter("ALL");
                  }}
                  className="mt-3 text-sm font-medium text-zinc-900 underline dark:text-zinc-100"
                >
                  Clear filters
                </button>
              </div>
            ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3">Business</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Gaps</th>
                  <th className="px-4 py-3">Rating</th>
                  <th className="px-4 py-3">Stage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
                {visible.map((b) => (
                  <tr key={b.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <td className="px-4 py-3">
                      <Link href={`/leads/${b.id}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-50">
                        {b.name}
                      </Link>
                      {b.address && <p className="text-xs text-zinc-500">{b.address}</p>}
                      {isStale(b) && (
                        <p
                          className="text-xs text-amber-600 dark:text-amber-400"
                          title={`Not returned by the last scan. Last seen ${formatTimestamp(b.lastSeenAt)}.`}
                        >
                          Not in last scan
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">{b.score.toFixed(1)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
                          WEBSITE_STATUS_STYLE[b.websiteStatus] ?? ""
                        }`}
                        title={WEBSITE_STATUS_HINT[b.websiteStatus]}
                      >
                        {WEBSITE_STATUS_LABEL[b.websiteStatus] ?? b.websiteStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {contactSummary(b).length ? (
                        <span className="flex flex-wrap gap-x-1.5">
                          {contactSummary(b).map((c, i, all) => (
                            <span key={c.label} title={c.value} className="whitespace-nowrap">
                              {c.label}
                              {i < all.length - 1 && ","}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-zinc-400 dark:text-zinc-500">None found</span>
                      )}
                    </td>
                    {/* Certainty travels with the label. An unverified signal must
                        never read here as an established fact. */}
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {b.signals.length ? (
                        <span className="flex flex-wrap gap-x-1.5">
                          {b.signals.map((s, i) => (
                            <span
                              key={s.id}
                              className={s.certainty === "UNCERTAIN" ? "text-amber-600 dark:text-amber-400" : undefined}
                              title={
                                s.certainty === "UNCERTAIN"
                                  ? "Unverified — a check failed, so this is not proven"
                                  : undefined
                              }
                            >
                              {s.label}
                              {s.certainty === "UNCERTAIN" && " (unverified)"}
                              {i < b.signals.length - 1 && ","}
                            </span>
                          ))}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {b.rating ? `${b.rating}★ (${b.reviewCount ?? 0})` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STAGE_STYLES[b.crmStage] ?? ""}`}>
                        {b.crmStage}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </>
        )}

        {campaign.scans.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Scan history</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              The {campaign.scans.length === 1 ? "only run so far" : `last ${campaign.scans.length} runs`}. A failed scan
              never removes leads found by an earlier one.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5">Started</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Took</th>
                    <th className="px-4 py-2.5">Found</th>
                    <th className="px-4 py-2.5">New</th>
                    <th className="px-4 py-2.5">Refreshed</th>
                    <th className="px-4 py-2.5">Skipped</th>
                    <th className="px-4 py-2.5" title="Websites over the per-scan check limit, left for the next scan">
                      Sites deferred
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
                  {campaign.scans.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {formatTimestamp(s.startedAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
                            SCAN_STATUS_STYLE[s.status] ?? ""
                          }`}
                        >
                          {s.status}
                        </span>
                        {s.errorMessage && (
                          <p className="mt-1 max-w-sm text-xs text-red-600 dark:text-red-400">{s.errorMessage}</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {formatDuration(s.startedAt, s.finishedAt)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-zinc-700 dark:text-zinc-300">{s.found}</td>
                      <td className="px-4 py-2.5 font-mono text-zinc-700 dark:text-zinc-300">{s.created}</td>
                      <td className="px-4 py-2.5 font-mono text-zinc-700 dark:text-zinc-300">{s.updated}</td>
                      <td className="px-4 py-2.5 font-mono text-zinc-700 dark:text-zinc-300">{s.skipped}</td>
                      <td className="px-4 py-2.5 font-mono text-zinc-700 dark:text-zinc-300">{s.deferred}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

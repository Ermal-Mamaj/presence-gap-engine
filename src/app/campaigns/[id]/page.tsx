"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contactChannels } from "@/lib/contacts";
import { CRM_STAGES } from "@/lib/crm";
import { followUpDay } from "@/lib/leads";
import { DRAFT_LANGUAGES, type DraftLanguage, isDraftLanguage } from "@/lib/outreachOptions";
import type { WebsiteStatus } from "@/lib/detect";
import {
  formatDay,
  formatDuration,
  localDay,
  formatTimestamp,
  SCAN_STATUS_STYLE,
  WEBSITE_STATUS_HINT,
  WEBSITE_STATUS_LABEL,
  WEBSITE_STATUS_STYLE,
} from "@/lib/display";

const WEBSITE_STATUSES: WebsiteStatus[] = ["NONE_FOUND", "NEEDS_WORK", "NEEDS_CHECK", "GOOD"];
type SortKey = "score" | "name" | "followUp";

// Leaflet needs the browser, and most visits never open the map.
const LeadMap = dynamic(() => import("./LeadMap"), {
  ssr: false,
  loading: () => <p className="mt-4 text-sm text-zinc-500">Loading map…</p>,
});

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
  emailFromSite: boolean;
  facebook: string | null;
  instagram: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviewCount: number | null;
  score: number;
  crmStage: string;
  websiteStatus: WebsiteStatus;
  lastSeenAt: string;
  followUpAt: string | null;
  onlineCheck: string | null;
  onlineCheckUrl: string | null;
  _count: { outreach: number };
  signals: GapSignal[];
}

type ContactFilter = "ALL" | "REACHABLE" | "EMAIL" | "NONE";

/** Short labels for the contact column, with the values themselves as tooltips. */
function contactSummary(b: Business): { label: string; value: string }[] {
  return [
    b.email && { label: "Email", value: b.emailFromSite ? `${b.email} (from their website; check it is theirs)` : b.email },
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
  language: string;
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
  const [rescoring, setRescoring] = useState(false);
  const [editing, setEditing] = useState(false);
  const [bulkDrafting, setBulkDrafting] = useState(false);
  const [online, setOnline] = useState<OnlineCheckState | null>(null);
  const onlineWasRunning = useRef(false);
  const [view, setView] = useState<"table" | "map">("table");
  const [rescoreNotice, setRescoreNotice] = useState<string | null>(null);
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
    // Soonest follow-up first; leads with nothing planned go last, by score.
    const followUpOrder = (b: Business) => (b.followUpAt ? new Date(b.followUpAt).getTime() : Infinity);
    return rows.sort((a, b) =>
      sortKey === "name"
        ? a.name.localeCompare(b.name)
        : sortKey === "followUp"
          ? followUpOrder(a) - followUpOrder(b) || b.score - a.score
          : b.score - a.score
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

  // The online check runs on the server; read its progress, and keep reading while it runs.
  const readOnlineCheck = useCallback(() => {
    return fetch(`/api/campaigns/${id}/online-check`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: OnlineCheckState | null) => {
        // When a run finishes, the leads have changed: reload them once.
        if (onlineWasRunning.current && data && !data.progress?.running) load();
        onlineWasRunning.current = Boolean(data?.progress?.running);
        setOnline(data);
      })
      .catch(() => undefined);
  }, [id, load]);

  useEffect(() => {
    readOnlineCheck();
  }, [readOnlineCheck]);

  useEffect(() => {
    if (!online?.progress?.running) return;
    const timer = setInterval(readOnlineCheck, 3000);
    return () => clearInterval(timer);
  }, [online?.progress?.running, readOnlineCheck]);

  async function handleOnlineCheck() {
    setError(null);
    const res = await fetch(`/api/campaigns/${id}/online-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) setError(data?.error ?? "Could not start the online check");
    await readOnlineCheck();
  }

  /** Drafts the best leads that are ready for a first message; see draftTopLeads. */
  async function handleBulkDraft() {
    setBulkDrafting(true);
    setError(null);
    setRescoreNotice(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not draft");
      const parts = [
        data.selected === 0
          ? "No lead is ready for a first draft: each needs a verified gap, no draft yet, and stage NEW or QUALIFIED."
          : `Drafted ${data.drafted} of ${data.selected}.`,
        data.failed.length ? `${data.failed.length} failed (${data.failed[0].name}: ${data.failed[0].error}).` : "",
        data.stoppedBecause ? `Stopped: ${data.stoppedBecause}` : "",
      ];
      setRescoreNotice(parts.filter(Boolean).join(" "));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBulkDrafting(false);
    }
  }

  /** Recomputes scores from stored signals; no website is fetched. */
  async function handleRescore() {
    setRescoring(true);
    setError(null);
    setRescoreNotice(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/rescore`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not recalculate scores");
      setRescoreNotice(
        data.changed === 0 ? "Scores are up to date." : `${data.changed} of ${data.rescored} scores changed.`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRescoring(false);
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
          {editing ? (
            <CampaignSettingsForm
              campaign={campaign}
              onDone={() => {
                setEditing(false);
                load();
              }}
            />
          ) : (
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                {campaign.name}{" "}
                <button
                  onClick={() => setEditing(true)}
                  className="align-middle text-xs font-normal text-zinc-500 underline hover:text-zinc-700"
                >
                  Edit
                </button>
              </h1>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {campaign.niche} in {campaign.region} · source: {campaign.source} · drafts in{" "}
                {isDraftLanguage(campaign.language) ? DRAFT_LANGUAGES[campaign.language] : campaign.language}
              </p>
            </div>
          )}
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
                <option value="followUp">Follow-up soonest</option>
              </select>

              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {filtering
                  ? `${visible.length} of ${campaign.businesses.length} leads`
                  : `${campaign.businesses.length} leads`}
              </span>

              <Link
                href={`/campaigns/${id}/review`}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Review &amp; send
              </Link>

              <span className="inline-flex overflow-hidden rounded-md border border-zinc-300 text-xs dark:border-zinc-700">
                {(["table", "map"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    aria-pressed={view === v}
                    className={`px-2.5 py-1.5 font-medium ${
                      view === v
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {v === "table" ? "Table" : "Map"}
                  </button>
                ))}
              </span>

              {rescoreNotice && <span className="text-xs text-zinc-500 dark:text-zinc-400">{rescoreNotice}</span>}

              <button
                onClick={handleOnlineCheck}
                disabled={!online?.provider || Boolean(online?.progress?.running)}
                title={
                  online?.provider
                    ? "Searches the web for the own website of up to 20 leads with none listed, and checks each page found against the lead's phone, name and street."
                    : "Set GROQ_API_KEY, OPENROUTER_API_KEY or TAVILY_API_KEY in .env to search the web for these leads."
                }
                className="ml-auto rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {online?.progress?.running
                  ? `Checking online ${online.progress.done}/${online.progress.total}…`
                  : "Check offline leads online"}
              </button>
              {online?.progress && !online.progress.running && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {online.progress.error
                    ? `Online check stopped: ${online.progress.error}`
                    : `Online check: ${online.progress.found} found, ${online.progress.none} not online, ${online.progress.unsure} unsure.`}
                </span>
              )}

              <button
                onClick={handleBulkDraft}
                disabled={bulkDrafting || scanning}
                title="Drafts the 10 highest-scoring leads that have a verified gap, no draft yet, and stage NEW or QUALIFIED, in the campaign's language. Takes about a minute."
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {bulkDrafting ? "Drafting…" : "Draft top 10"}
              </button>

              {/* A scan rewrites every score anyway, so this only matters between scans. */}
              <button
                onClick={handleRescore}
                disabled={rescoring || scanning}
                title="Recomputes every score from the gaps already found. No website is checked again."
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {rescoring ? "Recalculating…" : "Recalculate scores"}
              </button>

              {/* Exports the whole campaign, not the filtered view — said plainly
                  here so the two can't quietly disagree. */}
              <a
                href={`/api/campaigns/${id}/export`}
                title="Downloads every lead in this campaign, ignoring the filters above."
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
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
            ) : view === "map" ? (
              <div className="mt-4">
                <LeadMap leads={visible} />
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
                      <OnlineNote verdict={b.onlineCheck} url={b.onlineCheckUrl} />
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
                      {b.followUpAt && <FollowUpNote day={followUpDay(b.followUpAt)} />}
                      {b._count.outreach > 0 && (b.crmStage === "NEW" || b.crmStage === "QUALIFIED") && (
                        <p className="mt-1 whitespace-nowrap text-xs text-sky-700 dark:text-sky-400">Draft ready</p>
                      )}
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

        <DeleteCampaign campaign={campaign} scanning={scanning} />
      </main>
    </div>
  );
}

interface OnlineCheckState {
  provider: string | null;
  progress: { running: boolean; total: number; done: number; found: number; none: number; unsure: number; error: string | null } | null;
}

/** What the web search concluded about a lead with no website listed. */
function OnlineNote({ verdict, url }: { verdict: string | null; url: string | null }) {
  if (!verdict) return null;
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {}
  const text =
    verdict === "found" ? `Found online: ${host}` : verdict === "unsure" ? `Maybe online: ${host}, check it` : "Searched: not online";
  const tone = verdict === "unsure" ? "text-amber-700 dark:text-amber-400" : "text-zinc-500";
  return <p className={`mt-1 whitespace-nowrap text-xs ${tone}`}>{text}</p>;
}

/** When to get back to a lead, flagged once it is due. */
function FollowUpNote({ day }: { day: string }) {
  const today = localDay();
  return (
    <p
      className={`mt-1 whitespace-nowrap text-xs ${day <= today ? "font-medium text-amber-700 dark:text-amber-400" : "text-zinc-500"}`}
    >
      {day < today ? "Overdue: " : day === today ? "Due today" : "Follow up "}
      {day === today ? "" : formatDay(day)}
    </p>
  );
}

/** Rename the campaign or change the language its drafts are written in. Region and niche stay: they define what was scanned. */
function CampaignSettingsForm({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const [name, setName] = useState(campaign.name);
  const [language, setLanguage] = useState<DraftLanguage>(isDraftLanguage(campaign.language) ? campaign.language : "en");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, language }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save the campaign");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-zinc-500">
        Name
        <input
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-64 rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
      </label>
      <label className="text-xs text-zinc-500">
        Draft language
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as DraftLanguage)}
          className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        >
          {Object.entries(DRAFT_LANGUAGES).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" onClick={onDone} className="px-2 py-1.5 text-sm text-zinc-500 hover:underline">
        Cancel
      </button>
      {error && <p className="w-full text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}

/**
 * Deleting removes every lead, draft, note and stage history in the campaign,
 * so the confirmation says how much work that is before asking.
 */
function DeleteCampaign({ campaign, scanning }: { campaign: Campaign; scanning: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    const leads = campaign.businesses.length;
    const worked = campaign.businesses.filter((b) => b.crmStage !== "NEW").length;
    const message =
      `Delete "${campaign.name}" and its ${leads} lead${leads === 1 ? "" : "s"}?` +
      (worked ? ` ${worked === 1 ? "One has" : `${worked} of them have`} moved past NEW; their drafts, notes and history go too.` : "") +
      " This can't be undone. Export the CSV first if you might need them.";
    if (!window.confirm(message)) return;
    setDeleting(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/");
      return;
    }
    const data = await res.json().catch(() => null);
    setError(data?.error ?? "Could not delete the campaign");
    setDeleting(false);
  }

  return (
    <section className="mt-12 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <button
        onClick={remove}
        disabled={deleting || scanning}
        title={scanning ? "Wait for the scan to finish first." : undefined}
        className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      >
        {deleting ? "Deleting…" : "Delete campaign"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

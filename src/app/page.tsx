"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDay, localDay } from "@/lib/display";
import { followUpDay } from "@/lib/leads";
import type { PipelineSummary } from "@/lib/pipeline";
import type { OutreachStats, Tally } from "@/lib/stats";

interface CampaignSummary {
  id: string;
  name: string;
  region: string;
  niche: string;
  source: string;
  status: string;
  createdAt: string;
  _count: { businesses: number };
}

interface DueFollowUp {
  id: string;
  name: string;
  crmStage: string;
  followUpAt: string;
  phone: string | null;
  email: string | null;
  campaign: { id: string; name: string };
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  RUNNING: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  DONE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export default function Home() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [due, setDue] = useState<DueFollowUp[]>([]);
  const [pipeline, setPipeline] = useState<PipelineSummary | null>(null);
  const [stats, setStats] = useState<OutreachStats | null>(null);

  // Promise callbacks rather than async/await: state must not be set on the
  // effect's synchronous path (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    fetch("/api/campaigns")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Could not load campaigns");
        return data as CampaignSummary[];
      })
      .then((data) => {
        setCampaigns(data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Could not load campaigns");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // "Due" means on or before today where the user is, so the browser says
  // which day that is. A failure here only hides the panel.
  useEffect(() => {
    fetch(`/api/followups?through=${localDay()}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: DueFollowUp[]) => setDue(data))
      .catch(() => setDue([]));
    fetch("/api/pipeline")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PipelineSummary | null) => setPipeline(data))
      .catch(() => setPipeline(null));
    fetch("/api/stats")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: OutreachStats | null) => setStats(data))
      .catch(() => setStats(null));
  }, []);

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Presence Gap Engine
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Find → detect gap → rank → reach out. One campaign is one target box.
            </p>
          </div>
          <div className="flex items-center gap-3">
          <Link href="/templates" className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-300">
            Templates
          </Link>
          <Link
            href="/campaigns/new"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New campaign
          </Link>
          </div>
        </div>

        {due.length > 0 && <FollowUpsDue items={due} />}
        {pipeline && pipeline.total > 0 && <Pipeline summary={pipeline} />}
        {stats && stats.sent > 0 && <WhatWorks stats={stats} />}

        {loadError ? (
          <div>
            <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
              {loadError}
            </p>
            <button
              onClick={load}
              className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Try again
            </button>
          </div>
        ) : campaigns === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : campaigns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500">
              No campaigns yet. Start with a narrow box — one region, one niche, one weakness.
            </p>
            <Link href="/campaigns/new" className="mt-3 inline-block text-sm font-medium text-zinc-900 underline dark:text-zinc-100">
              Create your first campaign
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/campaigns/${c.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <div>
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">{c.name}</p>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {c.niche} in {c.region} · {c._count.businesses} leads
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[c.status]}`}>
                    {c.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

/** Every lead to get back to today or earlier, across campaigns, oldest first. */
function FollowUpsDue({ items }: { items: DueFollowUp[] }) {
  const today = localDay();
  return (
    <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-900/10">
      <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        Follow-ups due ({items.length})
      </h2>
      <ul className="mt-2 divide-y divide-amber-200/70 dark:divide-amber-900/40">
        {items.map((lead) => {
          const day = followUpDay(lead.followUpAt);
          return (
            <li key={lead.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
              <span>
                <Link href={`/leads/${lead.id}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-50">
                  {lead.name}
                </Link>
                <span className="text-zinc-500"> · {lead.campaign.name} · {lead.crmStage}</span>
              </span>
              <span className="text-xs text-amber-800 dark:text-amber-300">
                {day === today ? "Today" : `Overdue since ${formatDay(day)}`}
                {(lead.phone || lead.email) && <span className="text-zinc-500"> · {lead.phone ?? lead.email}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/** How far leads have got across every campaign: a funnel by furthest stage reached. */
/** A tally as "3 of 10 replied (30%)". With few sent, the share says little: the counts are shown first. */
function tallyText(t: Tally): string {
  return `${t.replied} of ${t.sent} replied (${percent(t.replyRate)})${t.converted > 0 ? `, ${t.converted} became clients` : ""}`;
}

function WhatWorks({ stats }: { stats: OutreachStats }) {
  const rows = (title: string, items: { key: string; label: string; tally: Tally }[]) => (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <ul className="mt-1 space-y-1">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
            <span className="text-zinc-800 dark:text-zinc-200">{item.label}</span>
            <span className="font-mono text-xs text-zinc-500">{tallyText(item.tally)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">What works</h2>
      <div className="mt-3 space-y-4">
        {rows("By message", stats.byTemplate.map((t) => ({ key: t.templateId ?? "none", label: t.label, tally: t })))}
        {rows("By channel", stats.byChannel.map((c) => ({ key: c.channel, label: c.channel, tally: c })))}
        {rows("By business type", stats.byNiche.map((n) => ({ key: n.niche, label: n.niche, tally: n })))}
      </div>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Each lead counts once, under the first message sent to it, and as a reply if it ever replied. A few messages prove
        little: wait for a dozen or more before choosing between two.
      </p>
    </section>
  );
}

function Pipeline({ summary }: { summary: PipelineSummary }) {
  // Past CONTACTED is where the work shows; earlier stages are mostly volume.
  const shown = summary.reached.filter((r) => r.stage !== "QUALIFIED");
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Pipeline</h2>
      <ol className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {shown.map((r) => (
          <li key={r.stage} className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
            <p className="font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-50">{r.count}</p>
            <p className="text-xs text-zinc-500">{r.stage === "NEW" ? "Leads" : `Reached ${r.stage.toLowerCase()}`}</p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {percent(summary.replyRate)} of contacted leads replied · {percent(summary.conversionRate)} of replies converted
        {summary.dead > 0 && ` · ${summary.dead} marked dead`}. Counted by the furthest stage each lead reached, so a lead
        that replied and later died still counts as a reply.
      </p>
    </section>
  );
}

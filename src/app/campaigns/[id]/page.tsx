"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface GapSignal {
  id: string;
  key: string;
  label: string;
  severity: number;
}

interface Business {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  score: number;
  crmStage: string;
  signals: GapSignal[];
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

  const load = useCallback(() => {
    fetch(`/api/campaigns/${id}`)
      .then((r) => r.json())
      .then(setCampaign);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      setCampaign(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  }

  if (!campaign) {
    return (
      <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 text-sm text-zinc-500">Loading…</main>
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
          <p className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            {campaign.errorMessage}
          </p>
        )}
        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </p>
        )}

        {campaign.businesses.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500">No leads yet. Run the pipeline to find and score businesses.</p>
          </div>
        ) : (
          <div className="mt-8 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3">Business</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Gaps</th>
                  <th className="px-4 py-3">Rating</th>
                  <th className="px-4 py-3">Stage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
                {campaign.businesses.map((b) => (
                  <tr key={b.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <td className="px-4 py-3">
                      <Link href={`/leads/${b.id}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-50">
                        {b.name}
                      </Link>
                      {b.address && <p className="text-xs text-zinc-500">{b.address}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">{b.score.toFixed(1)}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {b.signals.length ? b.signals.map((s) => s.label).join(", ") : "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {b.rating ? `${b.rating}★ (${b.reviewCount ?? 0})` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STAGE_STYLES[b.crmStage]}`}>
                        {b.crmStage}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

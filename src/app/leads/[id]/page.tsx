"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { safeHttpUrl } from "@/lib/url";

interface GapSignal {
  id: string;
  key: string;
  label: string;
  severity: number;
  certainty: string;
  detail: string | null;
}

interface Outreach {
  id: string;
  subject: string | null;
  openLine: string;
  body: string;
  createdAt: string;
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
  notes: string | null;
  signals: GapSignal[];
  outreach: Outreach[];
  campaign: { id: string; name: string };
}

const STAGES = ["NEW", "QUALIFIED", "CONTACTED", "REPLIED", "CONVERTED", "DELIVERED", "RETAINED", "DEAD"];

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [business, setBusiness] = useState<Business | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  const load = useCallback(() => {
    fetch(`/api/leads/${id}`)
      .then((r) => r.json())
      .then((b: Business) => {
        setBusiness(b);
        setNotes(b.notes ?? "");
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDraft() {
    setDrafting(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${id}/draft`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to draft outreach");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setDrafting(false);
    }
  }

  async function updateStage(crmStage: string) {
    const res = await fetch(`/api/leads/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crmStage }),
    });
    if (res.ok) {
      setError(null);
      load();
    } else {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "Could not change the stage");
    }
  }

  async function saveNotes() {
    await fetch(`/api/leads/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  }

  if (!business) {
    return (
      <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 text-sm text-zinc-500">Loading…</main>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <Link href={`/campaigns/${business.campaign.id}`} className="text-sm text-zinc-500 hover:underline">
          ← {business.campaign.name}
        </Link>

        <div className="mt-2 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{business.name}</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {business.address ?? "No address"} {business.phone ? `· ${business.phone}` : ""}
            </p>
            {business.website &&
              (safeHttpUrl(business.website) ? (
                <a href={safeHttpUrl(business.website)!} target="_blank" rel="noreferrer" className="text-sm text-sky-600 hover:underline dark:text-sky-400">
                  {business.website}
                </a>
              ) : (
                <p className="text-sm text-zinc-500">{business.website}</p>
              ))}
          </div>
          <div className="text-right">
            <p className="text-xs text-zinc-500">Score</p>
            <p className="font-mono text-xl font-semibold text-zinc-900 dark:text-zinc-50">{business.score.toFixed(1)}</p>
          </div>
        </div>

        <section className="mt-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">CRM stage</h2>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <button
                key={s}
                onClick={() => updateStage(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  s === business.crmStage
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Detected gaps</h2>
          {business.signals.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No gap signals detected.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {business.signals.map((s) => (
                <li key={s.id} className="text-sm text-zinc-700 dark:text-zinc-300">
                  <span className="font-mono text-xs text-zinc-400">[{s.severity}]</span> {s.label}
                  {s.certainty === "UNCERTAIN" && <span className="text-amber-600 dark:text-amber-400"> (unverified)</span>}
                  {s.detail && <span className="text-zinc-400"> — {s.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Outreach draft</h2>
            <button
              onClick={handleDraft}
              disabled={drafting}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {drafting ? "Drafting…" : business.outreach.length ? "Regenerate draft" : "Generate draft"}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          {business.outreach.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No draft yet.</p>
          ) : (
            <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs text-zinc-500">Subject</p>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{business.outreach[0].subject}</p>
              <p className="mt-3 text-xs text-zinc-500">Body</p>
              <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{business.outreach[0].body}</p>
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Notes</h2>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={saveNotes}
            rows={4}
            placeholder="Call notes, price quoted, follow-up date…"
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </section>
      </main>
    </div>
  );
}

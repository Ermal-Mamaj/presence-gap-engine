"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { canTransition, CRM_STAGES, isCrmStage } from "@/lib/crm";
import type { WebsiteStatus } from "@/lib/detect";
import {
  formatTimestamp,
  WEBSITE_STATUS_HINT,
  WEBSITE_STATUS_LABEL,
  WEBSITE_STATUS_STYLE,
} from "@/lib/display";
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

interface StageChange {
  id: string;
  fromStage: string;
  toStage: string;
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
  websiteStatus: WebsiteStatus;
  lastSeenAt: string;
  notes: string | null;
  signals: GapSignal[];
  outreach: Outreach[];
  stageChanges: StageChange[];
  campaign: { id: string; name: string };
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [business, setBusiness] = useState<Business | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [notesState, setNotesState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  /**
   * Whether the notes box holds edits the server hasn't accepted. A ref, not
   * state: `load` must read it without being rebuilt every keystroke.
   */
  const notesDirty = useRef(false);

  // Promise callbacks rather than async/await: state must not be set on the
  // effect's synchronous path (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    fetch(`/api/leads/${id}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Could not load this lead");
        return data as Business;
      })
      .then((data) => {
        setBusiness(data);
        // Never overwrite notes the user is still editing. A reload follows
        // every stage change and draft, and would otherwise discard them.
        if (!notesDirty.current) setNotes(data.notes ?? "");
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Could not load this lead");
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDraft() {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/leads/${id}/draft`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to draft outreach");
      load();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setDrafting(false);
    }
  }

  async function updateStage(crmStage: string) {
    // Clicking a stage doesn't blur the notes box, so persist what's in it
    // first. If this save fails the field stays dirty and keeps the text.
    if (notesDirty.current) await saveNotes();
    const res = await fetch(`/api/leads/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crmStage }),
    });
    if (res.ok) {
      setStageError(null);
      load();
    } else {
      const data = await res.json().catch(() => null);
      setStageError(data?.error ?? "Could not change the stage");
    }
  }

  async function saveNotes() {
    if (business && notes === (business.notes ?? "")) {
      notesDirty.current = false;
      return;
    }
    setNotesState("saving");
    try {
      const res = await fetch(`/api/leads/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error("save failed");
      setBusiness((prev) => (prev ? { ...prev, notes } : prev));
      notesDirty.current = false;
      setNotesState("saved");
    } catch {
      // Left dirty on purpose: the text stays in the box and a reload won't
      // replace it, so the user can retry instead of losing the note.
      setNotesState("error");
    }
  }

  if (!business) {
    return (
      <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
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

  const currentStage = isCrmStage(business.crmStage) ? business.crmStage : null;
  const latestDraft = business.outreach[0] ?? null;
  const olderDrafts = business.outreach.slice(1);

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
                <a
                  href={safeHttpUrl(business.website)!}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-sky-600 hover:underline dark:text-sky-400"
                >
                  {business.website}
                </a>
              ) : (
                <p className="text-sm text-zinc-500">{business.website}</p>
              ))}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${WEBSITE_STATUS_STYLE[business.websiteStatus] ?? ""}`}
                title={WEBSITE_STATUS_HINT[business.websiteStatus]}
              >
                {WEBSITE_STATUS_LABEL[business.websiteStatus] ?? business.websiteStatus}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Last seen in a scan {formatTimestamp(business.lastSeenAt)}
              </span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-zinc-500">Score</p>
            <p className="font-mono text-xl font-semibold text-zinc-900 dark:text-zinc-50">{business.score.toFixed(1)}</p>
          </div>
        </div>

        <section className="mt-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">CRM stage</h2>
          {stageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{stageError}</p>}
          {/* The same transition rules the API enforces, applied here, so an
              impossible move is visibly unavailable instead of failing on submit. */}
          <div className="mt-2 flex flex-wrap gap-2">
            {CRM_STAGES.map((s) => {
              const isCurrent = s === business.crmStage;
              const allowed = currentStage === null || isCurrent || canTransition(currentStage, s);
              return (
                <button
                  key={s}
                  onClick={() => updateStage(s)}
                  disabled={!allowed || isCurrent}
                  title={allowed ? undefined : `A lead in ${business.crmStage} can't move to ${s}`}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    isCurrent
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : allowed
                        ? "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                        : "cursor-not-allowed bg-zinc-50 text-zinc-300 dark:bg-zinc-900 dark:text-zinc-600"
                  }`}
                >
                  {s}
                </button>
              );
            })}
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
              {drafting ? "Drafting…" : latestDraft ? "Regenerate draft" : "Generate draft"}
            </button>
          </div>
          {draftError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{draftError}</p>}
          {!latestDraft ? (
            <p className="mt-2 text-sm text-zinc-500">No draft yet.</p>
          ) : (
            <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs text-zinc-500">Subject</p>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{latestDraft.subject}</p>
              <p className="mt-3 text-xs text-zinc-500">Body</p>
              <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{latestDraft.body}</p>
              <p className="mt-3 text-xs text-zinc-400">Drafted {formatTimestamp(latestDraft.createdAt)}</p>
            </div>
          )}
          {olderDrafts.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                {olderDrafts.length} earlier draft{olderDrafts.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-2 space-y-2">
                {olderDrafts.map((o) => (
                  <div
                    key={o.id}
                    className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <p className="text-xs text-zinc-400">{formatTimestamp(o.createdAt)}</p>
                    <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-50">{o.subject}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">{o.body}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        {business.stageChanges.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Stage history</h2>
            <ul className="mt-2 space-y-1">
              {business.stageChanges.map((c) => (
                <li key={c.id} className="text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="font-mono text-xs text-zinc-400">{formatTimestamp(c.createdAt)}</span>{" "}
                  {c.fromStage} → <span className="font-medium text-zinc-800 dark:text-zinc-200">{c.toStage}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Notes</h2>
            <span className="text-xs text-zinc-400">
              {notesState === "saving" && "Saving…"}
              {notesState === "saved" && "Saved"}
              {notesState === "error" && <span className="text-red-600 dark:text-red-400">Could not save</span>}
            </span>
          </div>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              notesDirty.current = true;
              setNotesState("idle");
            }}
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

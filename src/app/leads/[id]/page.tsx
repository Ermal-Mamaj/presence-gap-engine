"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ContactChannel, normalizeEmail, normalizePhone } from "@/lib/contacts";
import { canTransition, CRM_STAGES, isCrmStage } from "@/lib/crm";
import {
  CHANNEL_LABEL,
  defaultChannel,
  DRAFT_CHANNELS,
  DRAFT_LANGUAGES,
  type DraftChannel,
  isDraftChannel,
  isDraftLanguage,
} from "@/lib/outreachOptions";
import type { DetectedSignal, WebsiteStatus } from "@/lib/detect";
import { explainScore, gapContributions, UNCERTAIN_WEIGHT } from "@/lib/score";
import { followUpDay } from "@/lib/leads";
import {
  formatDay,
  formatTimestamp,
  localDay,
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
  channel: string;
  subject: string | null;
  openLine: string;
  body: string;
  sentAt: string | null;
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
  email: string | null;
  facebook: string | null;
  instagram: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  score: number;
  crmStage: string;
  websiteStatus: WebsiteStatus;
  siteCheckedAt: string | null;
  lastSeenAt: string;
  notes: string | null;
  followUpAt: string | null;
  signals: GapSignal[];
  outreach: Outreach[];
  stageChanges: StageChange[];
  campaign: { id: string; name: string; region: string; language: string };
}

const CHANNEL_NAMES: Record<ContactChannel, string> = { phone: "phone", email: "email", social: "social profile" };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));

/**
 * Why the lead scored what it did, term by term, from the same function that
 * computed it. If the weights changed since the last scan, the stored score
 * and this recomputation differ, and the panel says so instead of hiding it.
 */
function ScoreExplanation({ business }: { business: Business }) {
  // Stored certainty is a plain string; only an explicit UNCERTAIN is uncertain.
  const signals: DetectedSignal[] = business.signals.map((s) => ({
    key: s.key,
    label: s.label,
    severity: s.severity,
    certainty: s.certainty === "UNCERTAIN" ? "UNCERTAIN" : "VERIFIED",
  }));
  const b = explainScore(signals, business);
  const gaps = gapContributions(signals);
  const credits = [
    b.reviewCredit > 0 && `reviews +${fmt(b.reviewCredit)}`,
    b.ratingCredit > 0 && `rating +${fmt(b.ratingCredit)}`,
    b.contactCredit > 0 && `${b.channels.map((c) => CHANNEL_NAMES[c]).join(", ")} +${fmt(b.contactCredit)}`,
  ].filter(Boolean);

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Why this score</h2>
      {gaps.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No gap that counts was found, so the score is 0 however strong the business looks.</p>
      ) : (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-zinc-700 dark:text-zinc-300">
          <dt className="text-zinc-500">Gap points</dt>
          <dd>
            <span className="font-mono">{fmt(b.gapPoints)}</span>
            <span className="text-zinc-500">
              {" "}
              ={" "}
              {gaps
                .map(({ signal, points }) =>
                  signal.certainty === "UNCERTAIN"
                    ? `${signal.label} ${signal.severity} × ${UNCERTAIN_WEIGHT} (unverified)`
                    : `${signal.label} ${fmt(points)}`
                )
                .join(" + ")}
            </span>
          </dd>
          <dt className="text-zinc-500">Viability</dt>
          <dd>
            <span className="font-mono">× {fmt(b.viabilityMultiplier)}</span>
            <span className="text-zinc-500">
              {" "}
              = 1{credits.length ? ` + ${credits.join(" + ")}` : " (nothing known about reviews, rating or contact)"}
              {b.ghostPenaltyApplied && ", halved: the listing reports no reviews and there is no way to reach it"}
            </span>
          </dd>
          <dt className="text-zinc-500">Score</dt>
          <dd>
            <span className="font-mono">{fmt(b.score)}</span>
            {b.score >= 100 && <span className="text-zinc-500"> (capped at 100)</span>}
          </dd>
        </dl>
      )}
      {Math.abs(b.score - business.score) > 0.005 && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          The stored score is {business.score.toFixed(1)}, from weights that have changed since this lead was scored. Use
          Recalculate scores on the campaign page to update it.
        </p>
      )}
    </section>
  );
}

/** The day to get back to this lead, with a way to clear it, and a flag once it is due. */
function FollowUp({ day, onChange }: { day: string | null; onChange: (day: string | null) => void }) {
  const due = day !== null && day <= localDay();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="follow-up" className="text-zinc-600 dark:text-zinc-400">
        Follow up on
      </label>
      <input
        id="follow-up"
        type="date"
        value={day ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      {day && (
        <button onClick={() => onChange(null)} className="text-xs text-zinc-500 underline hover:text-zinc-700">
          Clear
        </button>
      )}
      {due && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {day === localDay() ? "Due today" : `Overdue since ${formatDay(day)}`}
        </span>
      )}
    </div>
  );
}

/** Drafts made before channels existed are stored as "email", which is what they were. */
function channelLabel(channel: string): string {
  return isDraftChannel(channel) ? CHANNEL_LABEL[channel] : channel;
}

const CONTACT_LINK_CLASS = "text-sky-600 hover:underline dark:text-sky-400";

/**
 * Every way to reach the lead, as links. The values are third-party data, so
 * each is re-validated before it becomes an href, and shown as plain text if
 * it doesn't pass. With nothing to go on, a web search is the next step.
 */
function ContactDetails({ business }: { business: Business }) {
  const phone = normalizePhone(business.phone);
  const email = normalizeEmail(business.email);
  const facebook = safeHttpUrl(business.facebook);
  const instagram = safeHttpUrl(business.instagram);

  if (!business.phone && !email && !facebook && !instagram) {
    const query = [business.name, business.address ?? business.campaign.region].join(" ");
    return (
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        No contact details found.{" "}
        <a
          href={`https://www.google.com/search?q=${encodeURIComponent(query)}`}
          target="_blank"
          rel="noreferrer"
          className={CONTACT_LINK_CLASS}
        >
          Search the web for this business
        </a>
      </p>
    );
  }

  return (
    <p className="mt-1 flex flex-wrap gap-x-3 text-sm">
      {business.phone &&
        (phone ? (
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className={CONTACT_LINK_CLASS}>
            {business.phone}
          </a>
        ) : (
          <span className="text-zinc-500 dark:text-zinc-400">{business.phone}</span>
        ))}
      {email && (
        <a href={`mailto:${email}`} className={CONTACT_LINK_CLASS}>
          {email}
        </a>
      )}
      {facebook && (
        <a href={facebook} target="_blank" rel="noreferrer" className={CONTACT_LINK_CLASS}>
          Facebook
        </a>
      )}
      {instagram && (
        <a href={instagram} target="_blank" rel="noreferrer" className={CONTACT_LINK_CLASS}>
          Instagram
        </a>
      )}
    </p>
  );
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
  const [copied, setCopied] = useState(false);
  /** The channel picked for the next draft; until one is, a channel the lead can be reached on. */
  const [pickedChannel, setPickedChannel] = useState<DraftChannel | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  /**
   * Copies the draft as pasteable text. An email gets its subject line on top;
   * a call script or a message is copied as it will be said or sent.
   */
  async function copyDraft(draft: Outreach) {
    const text = draft.channel === "email" && draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard needs a secure context and the user's permission, so it
      // can legitimately refuse. Say what to do instead of failing silently.
      setDraftError("Could not reach the clipboard. Select the draft and copy it manually.");
    }
  }

  async function handleDraft(channel: DraftChannel) {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/leads/${id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to draft outreach");
      load();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setDrafting(false);
    }
  }

  /** Saves or clears the follow-up day ("2026-10-17", or null). */
  async function setFollowUp(day: string | null) {
    if (notesDirty.current) await saveNotes();
    const res = await fetch(`/api/leads/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followUpAt: day }),
    });
    if (res.ok) {
      setStageError(null);
      load();
    } else {
      const data = await res.json().catch(() => null);
      setStageError(data?.error ?? "Could not save the follow-up date");
    }
  }

  /** Records that a draft went out; the server moves the lead to CONTACTED and plans a follow-up. */
  async function markSent(draftId: string) {
    if (notesDirty.current) await saveNotes();
    const res = await fetch(`/api/outreach/${draftId}/sent`, { method: "POST" });
    if (res.ok) {
      setDraftError(null);
      load();
    } else {
      const data = await res.json().catch(() => null);
      setDraftError(data?.error ?? "Could not mark the draft as sent");
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
  const channel = pickedChannel ?? defaultChannel(business);
  const draftLanguage = isDraftLanguage(business.campaign.language)
    ? DRAFT_LANGUAGES[business.campaign.language]
    : business.campaign.language;
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
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{business.address ?? "No address"}</p>
            <ContactDetails business={business} />
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
                {/* The site status is only as current as the check behind it. */}
                {business.website &&
                  (business.siteCheckedAt
                    ? ` · website checked ${formatTimestamp(business.siteCheckedAt)}`
                    : " · website not checked yet")}
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
          <FollowUp day={business.followUpAt ? followUpDay(business.followUpAt) : null} onChange={setFollowUp} />
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

        <ScoreExplanation business={business} />

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Outreach draft <span className="font-normal text-zinc-500">· in {draftLanguage}</span>
            </h2>
            <div className="flex items-center gap-2">
              {latestDraft && (
                <button
                  onClick={() => copyDraft(latestDraft)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
              <label htmlFor="draft-channel" className="sr-only">
                Draft for
              </label>
              <select
                id="draft-channel"
                value={channel}
                onChange={(e) => setPickedChannel(e.target.value as DraftChannel)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {DRAFT_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleDraft(channel)}
                disabled={drafting}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {drafting ? "Drafting…" : latestDraft ? "Regenerate draft" : "Generate draft"}
              </button>
            </div>
          </div>
          {draftError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{draftError}</p>}
          {!latestDraft ? (
            <p className="mt-2 text-sm text-zinc-500">No draft yet.</p>
          ) : (
            <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-medium text-zinc-500">{channelLabel(latestDraft.channel)}</p>
              <p className="mt-2 text-xs text-zinc-500">{latestDraft.channel === "email" ? "Subject" : "Title"}</p>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{latestDraft.subject}</p>
              <p className="mt-3 text-xs text-zinc-500">{latestDraft.channel === "phone" ? "Script" : "Body"}</p>
              <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{latestDraft.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                <span>Drafted {formatTimestamp(latestDraft.createdAt)}</span>
                {latestDraft.sentAt ? (
                  <span className="text-emerald-700 dark:text-emerald-400">Sent {formatTimestamp(latestDraft.sentAt)}</span>
                ) : (
                  <button
                    onClick={() => markSent(latestDraft.id)}
                    title="Records the send. A lead not yet contacted moves to CONTACTED, with a follow-up in 3 days if none is planned."
                    className="rounded-md border border-zinc-300 px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    Mark as sent
                  </button>
                )}
              </div>
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
                    <p className="text-xs text-zinc-400">
                      {channelLabel(o.channel)} · {formatTimestamp(o.createdAt)}
                      {o.sentAt && ` · sent ${formatTimestamp(o.sentAt)}`}
                    </p>
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

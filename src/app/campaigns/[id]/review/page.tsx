"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizeEmail, normalizePhone, whatsappLink } from "@/lib/contacts";
import { formatDay, formatTimestamp, localDay } from "@/lib/display";
import { followUpDay } from "@/lib/leads";
import { CHANNEL_LABEL, defaultChannel, DRAFT_CHANNELS, type DraftChannel, isDraftChannel } from "@/lib/outreachOptions";
import { safeHttpUrl } from "@/lib/url";

interface Card {
  leadId: string;
  name: string;
  address: string | null;
  score: number;
  crmStage: string;
  topGap: string | null;
  phone: string | null;
  email: string | null;
  emailFromSite: boolean;
  doNotContact: boolean;
  facebook: string | null;
  instagram: string | null;
  followUpAt: string | null;
  draft: {
    id: string;
    channel: string;
    subject: string | null;
    body: string;
    sentAt: string | null;
    fromTemplate: boolean;
    createdAt: string;
  } | null;
}

interface MailStatus {
  ready: boolean;
  dryRun: boolean;
  from: string | null;
  missing: string[];
  dailyLimit: number;
  sentLastDay: number;
}

interface Queue {
  campaign: { id: string; name: string };
  ready: Card[];
  needsDraft: Card[];
  sent: Card[];
}

type Tab = "ready" | "needsDraft" | "sent";
const TAB_LABEL: Record<Tab, string> = { ready: "Ready to send", needsDraft: "Needs a draft", sent: "Sent" };

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const PRIMARY =
  "rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900";
const INPUT =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

/**
 * One card per lead, grouped by what it needs next. Open a card to read and
 * edit its message, send it through the channel it was written for, and
 * record that it went out. Nothing is sent from here: the buttons open the
 * person's own email app, WhatsApp or the business's page.
 */
export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [tab, setTab] = useState<Tab>("ready");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mail, setMail] = useState<MailStatus | null>(null);

  const load = useCallback(() => {
    fetch("/api/mail")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MailStatus | null) => setMail(data))
      .catch(() => setMail(null));
    return fetch(`/api/campaigns/${id}/review`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Could not load the review queue");
        setQueue(data as Queue);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the review queue"));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const cards = queue?.[tab] ?? [];
  const current = useMemo(
    () => [...(queue?.ready ?? []), ...(queue?.needsDraft ?? []), ...(queue?.sent ?? [])].find((c) => c.leadId === selected) ?? null,
    [queue, selected]
  );

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
        <Link href={`/campaigns/${id}`} className="text-sm text-zinc-500 hover:underline">
          ← {queue?.campaign.name ?? "Campaign"}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Review &amp; send</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Read every message before it goes out. Sending opens your own email app, WhatsApp or the business&rsquo;s page;
          mark it sent once it has gone.
        </p>

        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-6 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setSelected(null);
              }}
              aria-pressed={tab === t}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t
                  ? "border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-50"
                  : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {TAB_LABEL[t]} <span className="text-xs text-zinc-400">{queue ? queue[t].length : ""}</span>
            </button>
          ))}
        </div>

        {queue === null ? (
          <p className="mt-6 text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <ul className="space-y-2">
              {cards.length === 0 && (
                <li className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  {tab === "ready"
                    ? "No drafts waiting. Draft leads from “Needs a draft”, or with Draft top 10 on the campaign."
                    : tab === "needsDraft"
                      ? "No lead is waiting for a draft."
                      : "Nothing sent yet."}
                </li>
              )}
              {cards.map((card) => (
                <li key={card.leadId}>
                  <button
                    onClick={() => setSelected(card.leadId)}
                    aria-pressed={selected === card.leadId}
                    className={`w-full rounded-lg border p-3 text-left ${
                      selected === card.leadId
                        ? "border-zinc-900 bg-white dark:border-zinc-100 dark:bg-zinc-950"
                        : "border-zinc-200 bg-white hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-50">{card.name}</span>
                      <span className="font-mono text-xs text-zinc-500">{card.score.toFixed(1)}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {[card.topGap, card.draft && isDraftChannel(card.draft.channel) ? CHANNEL_LABEL[card.draft.channel] : null, card.address]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {card.draft?.sentAt && (
                      <span className="mt-0.5 block text-xs text-emerald-700 dark:text-emerald-400">
                        Sent {formatTimestamp(card.draft.sentAt)}
                        {card.followUpAt && ` · follow up ${formatDay(followUpDay(card.followUpAt))}`}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>

            <div className="lg:sticky lg:top-6 lg:self-start">
              {current ? (
                <CardDetail key={`${current.leadId}:${current.draft?.id ?? "none"}`} card={current} mail={mail} onChanged={load} />
              ) : (
                cards.length > 0 && <p className="text-sm text-zinc-500">Pick a card to read its message.</p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/** How to reach the lead: each value that exists, as a link that does something. */
function Contacts({ card }: { card: Card }) {
  const email = normalizeEmail(card.email);
  const phone = normalizePhone(card.phone);
  const facebook = safeHttpUrl(card.facebook);
  const instagram = safeHttpUrl(card.instagram);
  const link = "text-sky-600 hover:underline dark:text-sky-400";
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 text-sm">
      {email && (
        <span>
          <a href={`mailto:${email}`} className={link}>
            {email}
          </a>
          {card.emailFromSite && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">from their website, check it is theirs</span>}
        </span>
      )}
      {phone && (
        <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className={link}>
          {card.phone}
        </a>
      )}
      {facebook && (
        <a href={facebook} target="_blank" rel="noreferrer" className={link}>
          Facebook
        </a>
      )}
      {instagram && (
        <a href={instagram} target="_blank" rel="noreferrer" className={link}>
          Instagram
        </a>
      )}
    </p>
  );
}

function CardDetail({
  card,
  mail,
  onChanged,
}: {
  card: Card;
  mail: MailStatus | null;
  onChanged: () => Promise<void> | void;
}) {
  const draft = card.draft;
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [channel, setChannel] = useState<DraftChannel>(defaultChannel(card));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== null && (subject !== (draft.subject ?? "") || body !== draft.body);

  async function call(url: string, init: RequestInit, failure: string) {
    const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? failure);
    return data;
  }

  async function act(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
      if (done) setNote(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    call(`/api/outreach/${draft!.id}`, { method: "PATCH", body: JSON.stringify({ subject, body }) }, "Could not save the changes");

  async function copy() {
    const text = draft?.channel === "email" && subject ? `Subject: ${subject}\n\n${body}` : body;
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied.");
    } catch {
      setError("Could not reach the clipboard. Select the text and copy it.");
    }
  }

  const email = normalizeEmail(card.email);
  const whatsapp = whatsappLink(card.phone);
  const facebook = safeHttpUrl(card.facebook);
  const instagram = safeHttpUrl(card.instagram);
  const phone = normalizePhone(card.phone);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{card.name}</h2>
        <Link href={`/leads/${card.leadId}`} className="text-xs text-zinc-500 underline">
          Open lead
        </Link>
      </div>
      <p className="text-sm text-zinc-500">{[card.address, card.topGap, `score ${card.score.toFixed(1)}`].filter(Boolean).join(" · ")}</p>
      <Contacts card={card} />

      {!draft ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select value={channel} onChange={(e) => setChannel(e.target.value as DraftChannel)} className={`${INPUT} mt-0 w-auto`}>
            {DRAFT_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            className={PRIMARY}
            onClick={() => act(() => call(`/api/leads/${card.leadId}/draft`, { method: "POST", body: JSON.stringify({ channel }) }, "Could not draft"))}
          >
            {busy ? "Drafting…" : "Draft"}
          </button>
        </div>
      ) : (
        <>
          <p className="mt-4 text-xs text-zinc-500">
            {isDraftChannel(draft.channel) ? CHANNEL_LABEL[draft.channel] : draft.channel}
            {draft.fromTemplate && " · from a template"} · drafted {formatTimestamp(draft.createdAt)}
          </p>
          {draft.sentAt ? (
            <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
              {draft.subject && <p className="font-medium text-zinc-900 dark:text-zinc-50">{draft.subject}</p>}
              <p className="mt-1 whitespace-pre-wrap">{draft.body}</p>
              <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
                Sent {formatTimestamp(draft.sentAt)}
                {card.followUpAt &&
                  ` · follow up ${formatDay(followUpDay(card.followUpAt))}${followUpDay(card.followUpAt) <= localDay() ? " (due)" : ""}`}
              </p>
            </div>
          ) : (
            <>
              <label className="mt-2 block text-xs text-zinc-500">
                {draft.channel === "email" ? "Subject" : "Title (for your records)"}
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className={INPUT} />
              </label>
              <label className="mt-2 block text-xs text-zinc-500">
                Message
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={INPUT} />
              </label>

              <div className="mt-3 flex flex-wrap gap-2">
                {dirty && (
                  <button disabled={busy} className={BUTTON} onClick={() => act(save, "Saved.")}>
                    Save changes
                  </button>
                )}
                <button className={BUTTON} onClick={copy}>
                  Copy
                </button>
                {draft.channel === "email" && email && !card.doNotContact && mail?.ready && (
                  <button
                    disabled={busy}
                    className={PRIMARY}
                    onClick={() => {
                      const what = mail.dryRun ? "Build this email as a dry run (nothing is sent)" : `Send this email to ${email} from ${mail.from}`;
                      if (!window.confirm(`${what}?`)) return;
                      act(async () => {
                        if (dirty) await save();
                        const result = await call(
                          `/api/outreach/${draft.id}/send`,
                          { method: "POST", body: JSON.stringify({ today: localDay() }) },
                          "Could not send the email"
                        );
                        setPreview(result.dryRun ? result.text : null);
                      }, mail.dryRun ? "Dry run: built, not sent. This is the text it would send:" : "Sent.");
                    }}
                  >
                    {mail.dryRun ? "Send email (dry run)" : "Send email"}
                  </button>
                )}
                {draft.channel === "email" && email && !card.doNotContact && (
                  <a className={BUTTON} href={`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
                    Open in email app
                  </a>
                )}
                {draft.channel === "message" && whatsapp && (
                  <a className={BUTTON} href={`${whatsapp}?text=${encodeURIComponent(body)}`} target="_blank" rel="noreferrer">
                    Open in WhatsApp
                  </a>
                )}
                {draft.channel === "message" && facebook && (
                  <a className={BUTTON} href={facebook} target="_blank" rel="noreferrer">
                    Open Facebook page
                  </a>
                )}
                {draft.channel === "message" && instagram && (
                  <a className={BUTTON} href={instagram} target="_blank" rel="noreferrer">
                    Open Instagram
                  </a>
                )}
                {draft.channel === "phone" && phone && (
                  <a className={BUTTON} href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
                    Call
                  </a>
                )}
                <button
                  disabled={busy}
                  className={PRIMARY}
                  title="Records that it went out. A lead not yet contacted moves to CONTACTED, with a follow-up in 3 days."
                  onClick={() =>
                    act(async () => {
                      // What was sent is what is recorded, so unsaved edits are saved first.
                      if (dirty) await save();
                      await call(`/api/outreach/${draft.id}/sent`, { method: "POST", body: JSON.stringify({ today: localDay() }) }, "Could not mark it sent");
                    }, "Marked as sent.")
                  }
                >
                  Mark as sent
                </button>
              </div>
            </>
          )}
        </>
      )}
      {draft?.channel === "email" && !draft.sentAt && card.doNotContact && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-400">
          This address is on the do-not-contact list, so it won&rsquo;t be sent.
        </p>
      )}
      {draft?.channel === "email" && !draft.sentAt && !card.doNotContact && mail && !mail.ready && (
        <p className="mt-2 text-xs text-zinc-500">
          Sending from the app isn&rsquo;t set up (needs {mail.missing.join(", ")} in .env); use Open in email app meanwhile.
        </p>
      )}
      {mail?.ready && draft?.channel === "email" && !draft.sentAt && (
        <p className="mt-1 text-xs text-zinc-400">
          {mail.sentLastDay} of {mail.dailyLimit} emails sent in the last 24 hours. The opt-out line is added when sending.
        </p>
      )}
      {email && !card.doNotContact && (
        <button
          disabled={busy}
          className="mt-3 text-xs text-red-700 underline dark:text-red-400"
          onClick={() => {
            if (!window.confirm(`Never contact ${email} again?`)) return;
            act(
              () => call("/api/do-not-contact", { method: "POST", body: JSON.stringify({ value: email, reason: "From the review page" }) }, "Could not add it"),
              "Added to the do-not-contact list."
            );
          }}
        >
          Do not contact this address
        </button>
      )}
      {note && <p className="mt-2 text-xs text-zinc-500">{note}</p>}
      {preview && <pre className="mt-1 whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{preview}</pre>}
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

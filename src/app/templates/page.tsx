"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHANNEL_LABEL,
  DRAFT_CHANNELS,
  DRAFT_LANGUAGES,
  type DraftChannel,
  type DraftLanguage,
  SUGGESTED_LANGUAGE,
} from "@/lib/outreachOptions";
import { fillTemplate, PLACEHOLDERS, type Placeholder, TEMPLATE_GAPS, type TemplateGap, templateProblems } from "@/lib/templateText";

interface Template {
  id: string;
  language: DraftLanguage;
  channel: DraftChannel;
  gapKey: TemplateGap;
  niche: string | null;
  subject: string | null;
  body: string;
  active: boolean;
  _count: { outreach: number };
}

type Draft = Omit<Template, "id" | "_count"> & { id?: string };

const blank = (language: DraftLanguage, gapKey: TemplateGap = "no_website", channel: DraftChannel = "email"): Draft => ({
  language,
  channel,
  gapKey,
  niche: null,
  subject: "",
  body: "",
  active: true,
});

// What a preview fills in, so the text can be read as a business would.
const SAMPLE = { name: "Klinika Arbëri", area: "Tirana", website: "klinika-arberi.al" };

const INPUT =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [language, setLanguage] = useState<DraftLanguage>(SUGGESTED_LANGUAGE);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/templates")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Could not load templates"))))
      .then((data: Template[]) => setTemplates(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load templates"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => (templates ?? []).filter((t) => t.language === language), [templates, language]);

  async function remove(t: Template) {
    const note = t._count.outreach ? ` ${t._count.outreach} draft(s) made from it keep their text.` : "";
    if (!window.confirm(`Delete this template?${note}`)) return;
    const res = await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
    if (res.ok) load();
    else setError("Could not delete the template");
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← All campaigns
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Message templates</h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
              Drafts are filled in from these. Write each in the language it is for, about one verified gap, for one
              channel. Several for the same gap and channel are variants: they rotate, so neighbouring businesses
              don&rsquo;t get the same text.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs text-zinc-500">
              Language
              <select value={language} onChange={(e) => setLanguage(e.target.value as DraftLanguage)} className={INPUT}>
                {Object.entries(DRAFT_LANGUAGES).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setEditing(blank(language))}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              New template
            </button>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {editing && (
          <TemplateForm
            draft={editing}
            onDone={() => {
              setEditing(null);
              load();
            }}
            onCancel={() => setEditing(null)}
          />
        )}

        {templates === null ? (
          <p className="mt-8 text-sm text-zinc-500">Loading…</p>
        ) : (
          <>
            <Coverage templates={shown} onAdd={(gapKey, channel) => setEditing(blank(language, gapKey, channel))} />
            <ul className="mt-6 space-y-3">
              {shown.length === 0 && (
                <li className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  No {DRAFT_LANGUAGES[language]} templates yet. Until there is one for a lead&rsquo;s gap and channel,
                  drafting that lead says so instead of writing anything.
                </li>
              )}
              {shown.map((t) => (
                <li key={t.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-xs text-zinc-500">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">{TEMPLATE_GAPS[t.gapKey]}</span> ·{" "}
                      {CHANNEL_LABEL[t.channel]} · {t.niche ? `only for ${t.niche}` : "any business type"} · used{" "}
                      {t._count.outreach}×{!t.active && " · inactive"}
                    </p>
                    <span className="flex gap-3 text-xs">
                      <button onClick={() => setEditing({ ...t })} className="text-zinc-600 underline dark:text-zinc-300">
                        Edit
                      </button>
                      <button onClick={() => remove(t)} className="text-red-700 underline dark:text-red-400">
                        Delete
                      </button>
                    </span>
                  </div>
                  <Preview template={t} />
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

/** Which gap and channel combinations have a template in this language, and which still need one. */
function Coverage({ templates, onAdd }: { templates: Template[]; onAdd: (gap: TemplateGap, channel: DraftChannel) => void }) {
  const count = (gap: string, channel: string) =>
    templates.filter((t) => t.gapKey === gap && t.channel === channel && t.active).length;
  return (
    <div className="mt-8 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full text-sm">
        <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
          <tr>
            <th className="px-3 py-2">Gap</th>
            {DRAFT_CHANNELS.map((c) => (
              <th key={c} className="px-3 py-2">
                {CHANNEL_LABEL[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {(Object.keys(TEMPLATE_GAPS) as TemplateGap[]).map((gap) => (
            <tr key={gap}>
              <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{TEMPLATE_GAPS[gap]}</td>
              {DRAFT_CHANNELS.map((c) => {
                const n = count(gap, c);
                return (
                  <td key={c} className="px-3 py-1.5">
                    {n > 0 ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {n} variant{n === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <button onClick={() => onAdd(gap, c)} className="text-xs text-zinc-400 underline hover:text-zinc-700">
                        add
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The template as a business would read it, with sample values filled in. */
function Preview({ template }: { template: Pick<Draft, "subject" | "body" | "niche"> }) {
  const values = { ...SAMPLE, business_type: template.niche ?? "dentist" };
  const subject = template.subject ? fillTemplate(template.subject, values) : null;
  const body = fillTemplate(template.body, values);
  return (
    <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
      {subject && <p className="font-medium text-zinc-900 dark:text-zinc-50">{subject}</p>}
      <p className="mt-1 whitespace-pre-wrap">{body ?? template.body}</p>
    </div>
  );
}

function TemplateForm({ draft, onDone, onCancel }: { draft: Draft; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const problems = templateProblems(form.subject, form.body);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Puts {{placeholder}} at the cursor, so nobody has to type the braces.
  function insert(p: Placeholder) {
    const el = bodyRef.current;
    const at = el?.selectionStart ?? form.body.length;
    set("body", `${form.body.slice(0, at)}{{${p}}}${form.body.slice(el?.selectionEnd ?? at)}`);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch(form.id ? `/api/templates/${form.id}` : "/api/templates", {
      method: form.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, id: undefined }),
    });
    if (res.ok) {
      onDone();
      return;
    }
    const data = await res.json().catch(() => null);
    setError(data?.error ?? "Could not save the template");
    setSaving(false);
  }

  return (
    <form onSubmit={save} className="mt-6 rounded-lg border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-zinc-500">
          Language
          <select value={form.language} onChange={(e) => set("language", e.target.value as DraftLanguage)} className={INPUT}>
            {Object.entries(DRAFT_LANGUAGES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-zinc-500">
          Channel
          <select value={form.channel} onChange={(e) => set("channel", e.target.value as DraftChannel)} className={INPUT}>
            {DRAFT_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-zinc-500 sm:col-span-2">
          Written about this verified gap
          <select value={form.gapKey} onChange={(e) => set("gapKey", e.target.value as TemplateGap)} className={INPUT}>
            {Object.entries(TEMPLATE_GAPS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-zinc-500 sm:col-span-2">
          Only for this business type (optional)
          <input value={form.niche ?? ""} onChange={(e) => set("niche", e.target.value || null)} placeholder="any" className={INPUT} />
        </label>
        <label className="text-xs text-zinc-500 sm:col-span-2">
          {form.channel === "email" ? "Subject" : "Title (for your records)"}
          <input value={form.subject ?? ""} onChange={(e) => set("subject", e.target.value)} className={INPUT} />
        </label>
      </div>
      <label className="mt-3 block text-xs text-zinc-500">
        Message
        <textarea ref={bodyRef} value={form.body} onChange={(e) => set("body", e.target.value)} rows={7} className={INPUT} />
      </label>
      <p className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
        Insert:
        {(Object.keys(PLACEHOLDERS) as Placeholder[]).map((p) => (
          <button key={p} type="button" onClick={() => insert(p)} title={PLACEHOLDERS[p]} className="rounded bg-zinc-100 px-1.5 font-mono dark:bg-zinc-800">
            {`{{${p}}}`}
          </button>
        ))}
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
        Active (used for new drafts)
      </label>

      {problems.length > 0 && (
        <ul className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {form.body.trim() && problems.length === 0 && (
        <div className="mt-3 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="text-xs text-zinc-500">Preview, with sample values</p>
          <Preview template={form} />
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={saving || problems.length > 0}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Saving…" : form.id ? "Save changes" : "Add template"}
        </button>
        <button type="button" onClick={onCancel} className="px-2 py-1.5 text-sm text-zinc-500 hover:underline">
          Cancel
        </button>
      </div>
    </form>
  );
}

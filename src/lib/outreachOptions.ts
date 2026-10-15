/**
 * What a draft can be written as: its language and the channel it will be
 * sent on. Kept apart from outreach.ts so client pages can import the lists
 * without pulling in the Anthropic SDK.
 */

export const DRAFT_LANGUAGES = {
  sq: "Albanian",
  en: "English",
  it: "Italian",
  de: "German",
  el: "Greek",
  sr: "Serbian",
  mk: "Macedonian",
} as const;

export type DraftLanguage = keyof typeof DRAFT_LANGUAGES;

/** The database default, so campaigns created before languages existed keep drafting as they did. */
export const DEFAULT_LANGUAGE: DraftLanguage = "en";

/** What the new-campaign form suggests: the businesses this tool targets are mostly Albanian-speaking. */
export const SUGGESTED_LANGUAGE: DraftLanguage = "sq";

export function isDraftLanguage(value: unknown): value is DraftLanguage {
  return typeof value === "string" && Object.hasOwn(DRAFT_LANGUAGES, value);
}

export const DRAFT_CHANNELS = ["email", "phone", "message"] as const;

export type DraftChannel = (typeof DRAFT_CHANNELS)[number];

export const CHANNEL_LABEL: Record<DraftChannel, string> = {
  email: "Email",
  phone: "Call script",
  message: "WhatsApp / Facebook message",
};

export function isDraftChannel(value: unknown): value is DraftChannel {
  return typeof value === "string" && (DRAFT_CHANNELS as readonly string[]).includes(value);
}

/**
 * The channel to draft for when none is chosen: one the lead can actually be
 * reached on, preferring the one that carries a written pitch best.
 */
export function defaultChannel(lead: {
  email?: string | null;
  phone?: string | null;
  facebook?: string | null;
  instagram?: string | null;
}): DraftChannel {
  if (lead.email) return "email";
  if (lead.facebook || lead.instagram) return "message";
  if (lead.phone) return "phone";
  return "email";
}

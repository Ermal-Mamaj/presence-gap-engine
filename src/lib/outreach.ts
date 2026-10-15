import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DetectedSignal } from "./detect";
import { DEFAULT_LANGUAGE, DRAFT_LANGUAGES, type DraftChannel, type DraftLanguage } from "./outreachOptions";

export interface OutreachTarget {
  name: string;
  address?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
}

export interface OutreachDraft {
  openLine: string;
  subject: string;
  body: string;
}

export type OutreachErrorKind = "no_verified_gaps" | "no_template" | "not_configured" | "invalid_response" | "upstream";

export class OutreachError extends Error {
  constructor(
    readonly kind: OutreachErrorKind,
    message: string
  ) {
    super(message);
    this.name = "OutreachError";
  }
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    open_line: {
      type: "string",
      description: "One or two sentences naming the specific, true gap observed about this business.",
    },
    subject: {
      type: "string",
      description:
        "For an email, a short, non-spammy subject line. For a call script or a message, a short title for the sender's own records.",
    },
    body: {
      type: "string",
      description:
        "The full text to send or say, including the open line, the offer, and a soft call to action. No sign-off placeholder needed.",
    },
  },
  required: ["open_line", "subject", "body"],
  additionalProperties: false,
};

// The JSON schema above is a request to the model, not a guarantee, so the
// response is checked again before anything is stored.
const draftSchema = z.object({
  open_line: z.string().trim().min(1).max(600),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(3000),
});

export function parseDraft(text: string): OutreachDraft {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OutreachError("invalid_response", "The model did not return valid JSON");
  }
  const parsed = draftSchema.safeParse(json);
  if (!parsed.success) {
    throw new OutreachError("invalid_response", "The model response did not match the expected draft format");
  }
  return { openLine: parsed.data.open_line, subject: parsed.data.subject, body: parsed.data.body };
}

/**
 * Only verified, scoring observations may be asserted to a business. An
 * uncertain one ("website did not load") might be our network, and telling an
 * owner their site is down when it isn't would sink the message.
 */
export function citableSignals(signals: DetectedSignal[]): DetectedSignal[] {
  return signals.filter((s) => s.certainty === "VERIFIED" && s.severity > 0);
}

export interface DraftOptions {
  language?: DraftLanguage;
  channel?: DraftChannel;
}

// What changes with the channel. The rules every channel shares stay in
// buildPrompt, so the three can't drift apart on what matters: one specific
// gap, no invented facts, a soft ask.
const CHANNEL_RULES: Record<DraftChannel, string> = {
  email: `Write a short, specific, non-templated outreach email.
- Keep it short (under 120 words), plain, no corporate tone, no emojis, no exclamation points.`,
  phone: `Write a script for a short phone call, to be read aloud by the freelancer.
- Spoken language: short sentences, nothing that only works on paper. Under 100 words.
- Start by saying who is calling and why in one sentence, then ask whether it is a good moment.
- End with a question that is easy to answer on the spot, such as whether they would like to see an example.`,
  message: `Write a WhatsApp or Facebook message to the business.
- Two to four short sentences, conversational, no greeting formula, no emojis, no exclamation points.
- It has to make sense to someone who reads only its first line in a notification.`,
};

export function buildPrompt(target: OutreachTarget, signals: DetectedSignal[], options: DraftOptions = {}): string {
  const language = DRAFT_LANGUAGES[options.language ?? DEFAULT_LANGUAGE];
  const channel = options.channel ?? "email";
  const signalLines = signals.map((s) => `- ${s.label}${s.detail ? ` (${s.detail})` : ""}`).join("\n");
  const rating = typeof target.rating === "number" && target.rating > 0 ? target.rating : null;
  const reviews = typeof target.reviewCount === "number" && target.reviewCount > 0 ? target.reviewCount : null;

  return `You are helping a small web-services freelancer reach out to a local business.

Business: ${target.name}
${target.address ? `Address: ${target.address}\n` : ""}${target.website ? `Website: ${target.website}\n` : ""}${rating !== null ? `Rating: ${rating}\n` : ""}${reviews !== null ? `Reviews: ${reviews}\n` : ""}
Observed gaps (publicly visible, true, specific):
${signalLines}

${CHANNEL_RULES[channel]}
- Open by naming the ONE most striking gap in concrete terms (e.g. "your clinic doesn't come up on Google and has no website" — not vague like "improve your online presence").
- Sell the outcome (customers can find and message them), not "a website".
- Offer to fix it, not a hard pitch. End with a low-friction ask (a quick reply or call).
- Do not invent facts not present in the signals above.
- Write everything in ${language}. The observations are listed in English; state them naturally in ${language}, without adding to them.`;
}

interface MessageLike {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}

export interface OutreachDeps {
  /** Replaceable for tests. */
  createMessage?: (prompt: string) => Promise<MessageLike>;
}

let client: Anthropic | undefined;

/**
 * draftSchema permits a subject (200), open line (600) and body (3000
 * characters) — roughly 1,100 tokens once JSON-escaped. A 1024 budget sat
 * below the schema's own ceiling, so a long draft was truncated and reported
 * as "stopped early" rather than returned.
 */
export const MAX_DRAFT_TOKENS = 4000;

/**
 * Distinguishes "there are no usable credentials" from an upstream fault.
 *
 * The SDK resolves credentials while building the request and throws before
 * anything is sent, so a failure that never became an APIError means we never
 * reached the API; a 401 means it rejected what we sent. Network faults are
 * APIConnectionError, which is an APIError, so they stay upstream.
 */
function asCredentialError(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError || !(err instanceof Anthropic.APIError)) {
    return new OutreachError(
      "not_configured",
      "No usable Claude credentials. Set ANTHROPIC_API_KEY, or sign in with `ant auth login`."
    );
  }
  return err;
}

async function createMessageWithClaude(prompt: string): Promise<MessageLike> {
  // No env pre-check: the SDK resolves ANTHROPIC_API_KEY, then
  // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile. Testing one
  // variable here rejected setups the SDK would have authenticated.
  client ??= new Anthropic();
  try {
    return await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: MAX_DRAFT_TOKENS,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: RESPONSE_SCHEMA },
      },
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    throw asCredentialError(err);
  }
}

export async function draftOutreach(
  target: OutreachTarget,
  signals: DetectedSignal[],
  deps: OutreachDeps = {},
  options: DraftOptions = {}
): Promise<OutreachDraft> {
  const citable = citableSignals(signals);
  if (citable.length === 0) {
    throw new OutreachError(
      "no_verified_gaps",
      "This lead has no verified gap to mention yet. Check its website first, then draft."
    );
  }

  let response: MessageLike;
  try {
    response = await (deps.createMessage ?? createMessageWithClaude)(buildPrompt(target, citable, options));
  } catch (err) {
    if (err instanceof OutreachError) throw err;
    throw new OutreachError("upstream", err instanceof Error ? err.message : "Draft generation failed");
  }

  if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
    throw new OutreachError("invalid_response", `Draft generation stopped early (${response.stop_reason})`);
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new OutreachError("invalid_response", "No text response from outreach draft generation");
  }
  return parseDraft(textBlock.text);
}

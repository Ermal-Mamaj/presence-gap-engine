import Anthropic from "@anthropic-ai/sdk";
import type { DetectedSignal } from "./detect";

const client = new Anthropic();

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

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    open_line: {
      type: "string",
      description: "One or two sentences naming the specific, true gap observed about this business.",
    },
    subject: {
      type: "string",
      description: "A short, non-spammy email subject line.",
    },
    body: {
      type: "string",
      description: "The full outreach email body, including the open line, the offer, and a soft call to action. No sign-off placeholder needed.",
    },
  },
  required: ["open_line", "subject", "body"],
  additionalProperties: false,
};

export async function draftOutreach(
  target: OutreachTarget,
  signals: DetectedSignal[]
): Promise<OutreachDraft> {
  const signalLines = signals.map((s) => `- ${s.label}${s.detail ? ` (${s.detail})` : ""}`).join("\n");

  const prompt = `You are helping a small web-services freelancer write a cold outreach email to a local business.

Business: ${target.name}
${target.address ? `Address: ${target.address}\n` : ""}${target.website ? `Website: ${target.website}\n` : ""}${target.rating ? `Rating: ${target.rating}\n` : ""}${target.reviewCount ? `Reviews: ${target.reviewCount}\n` : ""}
Observed gaps (publicly visible, true, specific):
${signalLines}

Write a short, specific, non-templated outreach email. Rules:
- Open by naming the ONE most striking gap in concrete terms (e.g. "your clinic doesn't come up on Google and has no website" — not vague like "improve your online presence").
- Sell the outcome (customers can find and message them), not "a website".
- Keep it short (under 120 words), plain, no corporate tone, no emojis, no exclamation points.
- Offer to fix it, not a hard pitch. End with a low-friction ask (a quick reply or call).
- Do not invent facts not present in the signals above.`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from outreach draft generation");
  }
  const parsed = JSON.parse(textBlock.text) as { open_line: string; subject: string; body: string };

  return { openLine: parsed.open_line, subject: parsed.subject, body: parsed.body };
}

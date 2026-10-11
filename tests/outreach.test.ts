import { describe, expect, it, vi } from "vitest";
import type { DetectedSignal } from "@/lib/detect";
import { buildPrompt, citableSignals, draftOutreach, MAX_DRAFT_TOKENS, OutreachError, parseDraft } from "@/lib/outreach";

const verified: DetectedSignal = {
  key: "no_mobile_viewport",
  label: "Site has no mobile viewport tag",
  severity: 15,
  certainty: "VERIFIED",
};
const uncertain: DetectedSignal = {
  key: "site_unreachable",
  label: "Website did not load",
  severity: 35,
  certainty: "UNCERTAIN",
};
const zeroSeverity: DetectedSignal = {
  key: "site_not_checked",
  label: "Website could not be checked",
  severity: 0,
  certainty: "VERIFIED",
};

const validJson = JSON.stringify({
  open_line: "Your site is hard to use on a phone.",
  subject: "A faster site for your clinic",
  body: "Hello, your site has no mobile layout. I can fix it. Want a quick call?",
});

const reply = (text: string, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason });

describe("parseDraft", () => {
  it("maps the snake_case model output to a draft", () => {
    expect(parseDraft(validJson)).toEqual({
      openLine: "Your site is hard to use on a phone.",
      subject: "A faster site for your clinic",
      body: "Hello, your site has no mobile layout. I can fix it. Want a quick call?",
    });
  });

  it("trims whitespace", () => {
    const json = JSON.stringify({ open_line: "  a ", subject: " b ", body: " c " });
    expect(parseDraft(json)).toEqual({ openLine: "a", subject: "b", body: "c" });
  });

  it("ignores extra fields", () => {
    const json = JSON.stringify({ open_line: "a", subject: "b", body: "c", extra: "x" });
    expect(parseDraft(json)).toEqual({ openLine: "a", subject: "b", body: "c" });
  });

  it.each([
    ["not JSON", "this is not json"],
    ["an empty string", ""],
    ["a JSON array", "[]"],
    ["null", "null"],
    ["a missing field", JSON.stringify({ open_line: "a", subject: "b" })],
    ["an empty field", JSON.stringify({ open_line: "a", subject: "", body: "c" })],
    ["a blank field", JSON.stringify({ open_line: "   ", subject: "b", body: "c" })],
    ["a non-string field", JSON.stringify({ open_line: "a", subject: 7, body: "c" })],
    ["an over-long body", JSON.stringify({ open_line: "a", subject: "b", body: "x".repeat(3001) })],
    ["an over-long subject", JSON.stringify({ open_line: "a", subject: "x".repeat(201), body: "c" })],
  ])("rejects %s", (_name, text) => {
    expect(() => parseDraft(text)).toThrowError(OutreachError);
    try {
      parseDraft(text);
    } catch (err) {
      expect((err as OutreachError).kind).toBe("invalid_response");
    }
  });
});

describe("citableSignals", () => {
  it("keeps only verified signals that carry weight", () => {
    expect(citableSignals([verified, uncertain, zeroSeverity])).toEqual([verified]);
  });
});

describe("buildPrompt", () => {
  it("states what was observed and omits unknown rating data", () => {
    const prompt = buildPrompt({ name: "Clinic", website: "https://clinic.example", rating: 0, reviewCount: 0 }, [verified]);
    expect(prompt).toContain("Business: Clinic");
    expect(prompt).toContain("Site has no mobile viewport tag");
    expect(prompt).not.toContain("Rating:");
    expect(prompt).not.toContain("Reviews:");
  });

  it("includes real rating data", () => {
    const prompt = buildPrompt({ name: "Clinic", rating: 4.5, reviewCount: 20 }, [verified]);
    expect(prompt).toContain("Rating: 4.5");
    expect(prompt).toContain("Reviews: 20");
  });
});

describe("draftOutreach", () => {
  it("returns a validated draft", async () => {
    const createMessage = vi.fn().mockResolvedValue(reply(validJson));
    const draft = await draftOutreach({ name: "Clinic" }, [verified], { createMessage });
    expect(draft.subject).toBe("A faster site for your clinic");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("never gives the model an uncertain observation to state as fact", async () => {
    const createMessage = vi.fn().mockResolvedValue(reply(validJson));
    await draftOutreach({ name: "Clinic" }, [verified, uncertain], { createMessage });
    const prompt = createMessage.mock.calls[0][0] as string;
    expect(prompt).toContain("Site has no mobile viewport tag");
    expect(prompt).not.toContain("Website did not load");
  });

  it("refuses to draft, without calling the model, when nothing is verified", async () => {
    const createMessage = vi.fn();
    await expect(draftOutreach({ name: "Clinic" }, [uncertain, zeroSeverity], { createMessage })).rejects.toMatchObject({
      kind: "no_verified_gaps",
    });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("rejects a response that does not match the schema", async () => {
    const createMessage = vi.fn().mockResolvedValue(reply(JSON.stringify({ subject: "only a subject" })));
    await expect(draftOutreach({ name: "Clinic" }, [verified], { createMessage })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("rejects a response with no text", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: [{ type: "thinking" }], stop_reason: "end_turn" });
    await expect(draftOutreach({ name: "Clinic" }, [verified], { createMessage })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it.each(["max_tokens", "refusal"])("rejects a response that stopped with %s", async (stop) => {
    const createMessage = vi.fn().mockResolvedValue(reply(validJson, stop));
    await expect(draftOutreach({ name: "Clinic" }, [verified], { createMessage })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("wraps an upstream failure", async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error("529 overloaded"));
    await expect(draftOutreach({ name: "Clinic" }, [verified], { createMessage })).rejects.toMatchObject({
      kind: "upstream",
      message: "529 overloaded",
    });
  });

  it("reports a missing API key distinctly when using the real client", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(draftOutreach({ name: "Clinic" }, [verified])).rejects.toMatchObject({ kind: "not_configured" });
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("budgets enough output tokens for the largest draft the schema allows", () => {
    // draftSchema caps subject at 200, open_line at 600 and body at 3000
    // characters. At a deliberately pessimistic 3 characters per token (English
    // prose runs nearer 4, and JSON escaping only adds), the largest valid
    // draft must still fit. A 1024 budget did not, so a long draft died as
    // stop_reason max_tokens instead of being returned.
    const worstCaseTokens = Math.ceil((200 + 600 + 3000) / 3);
    expect(MAX_DRAFT_TOKENS).toBeGreaterThan(worstCaseTokens);
  });
});

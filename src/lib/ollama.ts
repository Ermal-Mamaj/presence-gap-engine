/**
 * Drafting with a local model through Ollama, as a free alternative to the
 * Claude API. Chosen with DRAFT_PROVIDER=ollama; the model and server come
 * from OLLAMA_MODEL and OLLAMA_URL. The prompt, the JSON schema and the
 * validation of the answer are the same as for Claude (src/lib/outreach.ts):
 * only the call differs.
 *
 * A local model is free but weaker, especially in languages other than
 * English, and on a machine without a capable GPU it is slow. Read its drafts
 * before sending them.
 */

export type DraftProvider = "claude" | "ollama";

export function draftProvider(): DraftProvider {
  return process.env.DRAFT_PROVIDER?.trim().toLowerCase() === "ollama" ? "ollama" : "claude";
}

export function ollamaConfig() {
  return {
    url: (process.env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: process.env.OLLAMA_MODEL?.trim() || "llama3.2",
  };
}

// Generating on a CPU can take a minute or more for one draft.
const OLLAMA_TIMEOUT_MS = 180_000;

/** Why a call to Ollama failed, in terms of what to do about it. */
export class OllamaError extends Error {
  constructor(
    readonly kind: "not_running" | "model_missing" | "failed",
    message: string
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

interface MessageLike {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}

/**
 * One chat request to Ollama, answered in the same shape as a Claude message
 * so the rest of drafting doesn't care which model wrote it. `format` holds
 * the response JSON schema, which Ollama enforces while generating.
 */
export async function createMessageWithOllama(
  prompt: string,
  schema: object,
  maxTokens: number
): Promise<MessageLike> {
  const { url, model } = ollamaConfig();
  let res: Response;
  try {
    res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        format: schema,
        options: { num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new OllamaError("failed", `Ollama took longer than ${OLLAMA_TIMEOUT_MS / 1000}s to answer`);
    }
    throw new OllamaError("not_running", `Ollama isn't running at ${url}. Start it with \`ollama serve\`.`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 404 && /not found/i.test(detail)) {
      throw new OllamaError("model_missing", `The model "${model}" isn't downloaded. Run \`ollama pull ${model}\`.`);
    }
    throw new OllamaError("failed", `Ollama error: ${res.status} ${detail.slice(0, 200)}`.trim());
  }

  const data = (await res.json()) as { message?: { content?: string }; done_reason?: string };
  return {
    content: [{ type: "text", text: data.message?.content ?? "" }],
    // Ollama says "length" where Claude says "max_tokens"; drafting treats both as cut off.
    stop_reason: data.done_reason === "length" ? "max_tokens" : "end_turn",
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageWithOllama, draftProvider, ollamaConfig, OllamaError } from "@/lib/ollama";
import { draftOutreach, OutreachError } from "@/lib/outreach";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const DRAFT = JSON.stringify({ open_line: "o", subject: "s", body: "b" });
const SIGNALS = [{ key: "no_website", label: "No website found", severity: 40, certainty: "VERIFIED" as const }];

function stubOllama(answer: () => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return answer();
    })
  );
  return calls;
}

describe("draftProvider and ollamaConfig", () => {
  it("drafts with Claude unless told otherwise", () => {
    expect(draftProvider()).toBe("claude");
    vi.stubEnv("DRAFT_PROVIDER", " Ollama ");
    expect(draftProvider()).toBe("ollama");
  });

  it("defaults to a local server and llama3.2, and can be pointed elsewhere", () => {
    expect(ollamaConfig()).toEqual({ url: "http://127.0.0.1:11434", model: "llama3.2" });
    vi.stubEnv("OLLAMA_URL", "http://gpu-box:11434/");
    vi.stubEnv("OLLAMA_MODEL", "gemma3:4b");
    expect(ollamaConfig()).toEqual({ url: "http://gpu-box:11434", model: "gemma3:4b" });
  });
});

describe("createMessageWithOllama", () => {
  it("asks for one non-streamed answer in the response schema, and returns it like a Claude message", async () => {
    const calls = stubOllama(() => Response.json({ message: { content: DRAFT }, done_reason: "stop" }));
    const schema = { type: "object" };
    const reply = await createMessageWithOllama("prompt", schema, 4000);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].body).toMatchObject({
      model: "llama3.2",
      stream: false,
      format: schema,
      messages: [{ role: "user", content: "prompt" }],
      options: { num_predict: 4000 },
    });
    expect(reply).toEqual({ content: [{ type: "text", text: DRAFT }], stop_reason: "end_turn" });
  });

  it("reports a cut-off answer the way Claude does", async () => {
    stubOllama(() => Response.json({ message: { content: "{" }, done_reason: "length" }));
    expect((await createMessageWithOllama("p", {}, 10)).stop_reason).toBe("max_tokens");
  });

  it("says how to fix a server that isn't running or a model that isn't downloaded", async () => {
    stubOllama(() => {
      throw new TypeError("fetch failed");
    });
    await expect(createMessageWithOllama("p", {}, 10)).rejects.toMatchObject({ kind: "not_running", message: expect.stringContaining("ollama serve") });

    stubOllama(() => new Response('{"error":"model \\"llama3.2\\" not found, try pulling it first"}', { status: 404 }));
    await expect(createMessageWithOllama("p", {}, 10)).rejects.toMatchObject({ kind: "model_missing", message: expect.stringContaining("ollama pull llama3.2") });
  });

  it("reports any other failure as a failure", async () => {
    stubOllama(() => new Response("boom", { status: 500 }));
    await expect(createMessageWithOllama("p", {}, 10)).rejects.toBeInstanceOf(OllamaError);
  });
});

describe("draftOutreach with DRAFT_PROVIDER=ollama", () => {
  it("drafts through the local model and validates the answer as for Claude", async () => {
    vi.stubEnv("DRAFT_PROVIDER", "ollama");
    const calls = stubOllama(() => Response.json({ message: { content: DRAFT }, done_reason: "stop" }));
    const draft = await draftOutreach({ name: "Klinika" }, SIGNALS, {}, { language: "sq" });
    expect(draft).toEqual({ openLine: "o", subject: "s", body: "b" });
    expect(String((calls[0].body.messages as { content: string }[])[0].content)).toContain("Albanian");
  });

  it("treats a missing server as a setup problem, so bulk drafting stops at the first one", async () => {
    vi.stubEnv("DRAFT_PROVIDER", "ollama");
    stubOllama(() => {
      throw new TypeError("fetch failed");
    });
    await expect(draftOutreach({ name: "Klinika" }, SIGNALS)).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("rejects an answer that breaks the draft schema", async () => {
    vi.stubEnv("DRAFT_PROVIDER", "ollama");
    stubOllama(() => Response.json({ message: { content: '{"subject":"only"}' }, done_reason: "stop" }));
    await expect(draftOutreach({ name: "Klinika" }, SIGNALS)).rejects.toBeInstanceOf(OutreachError);
  });
});

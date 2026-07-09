import "server-only";

import { LANGFLOW_API_KEY, LANGFLOW_BASE_URL } from "@/lib/config";

// One thin transport for every Langflow flow the app runs (Task 6). Both LLM
// lanes are "Langflow-first, Groq-direct-fallback", so the POST + envelope
// extraction lives in exactly ONE place: chat (actions.ts) and analysis
// (market-data/analysis.ts) both call runLangflowFlow and differ only in which
// flow id / input / tweaks they pass. Callers own the breaker + fallback; this
// function only knows how to make the call and throw cleanly when it can't.

// Langflow (esp. a cold Hugging Face Space) can take a while to answer, but a
// caller must never hang a serverless invocation forever. 55s mirrors the chat
// path's historical budget and stays under Vercel's function ceiling.
const DEFAULT_TIMEOUT_MS = 55_000;

type RunLangflowArgs = {
  /** The hosted flow id to POST to (chat flow id, analysis flow id, …). */
  flowId: string;
  /** input_value for the flow's ChatInput node. */
  input: string;
  /** Optional per-node overrides (grounding / system message injection). */
  tweaks?: Record<string, unknown>;
  /** Optional chat session id for flows that store history. */
  sessionId?: string;
  /** Override the default request timeout. */
  timeoutMs?: number;
};

// Langflow's run envelope nests the terminal ChatOutput message a few levels
// deep, and the exact key has shifted across versions (…message.text vs
// …message.data.text). Both shapes are checked so a minor Langflow upgrade
// doesn't silently break extraction.
type LangflowRunResponse = {
  outputs?: {
    outputs?: {
      results?: { message?: { text?: string; data?: { text?: string } } };
    }[];
  }[];
};

function extractText(data: LangflowRunResponse): string | undefined {
  const message = data?.outputs?.[0]?.outputs?.[0]?.results?.message;
  return message?.text ?? message?.data?.text;
}

// Run a flow and return the ChatOutput text. Throws on missing config, a
// non-200, or an envelope we can't extract text from — the caller turns any
// throw into a breaker failure + fallback.
export async function runLangflowFlow(args: RunLangflowArgs): Promise<string> {
  if (!LANGFLOW_BASE_URL || !LANGFLOW_API_KEY) {
    throw new Error("Langflow base URL / API key is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `${LANGFLOW_BASE_URL}/api/v1/run/${args.flowId}`,
      {
        method: "POST",
        headers: {
          // Kept identical to the call actions.ts used to make inline: HF Spaces
          // gate on x-api-key, some proxies on Authorization — send both.
          "x-api-key": LANGFLOW_API_KEY,
          Authorization: `Bearer ${LANGFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_value: args.input,
          output_type: "chat",
          input_type: "chat",
          ...(args.sessionId ? { session_id: args.sessionId } : {}),
          ...(args.tweaks ? { tweaks: args.tweaks } : {}),
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Langflow responded with ${response.status}`);
    }

    const data = (await response.json()) as LangflowRunResponse;
    const text = extractText(data);
    if (!text) {
      throw new Error("Unexpected Langflow response shape");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

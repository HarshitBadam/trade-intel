import "server-only";

import { LANGFLOW_API_KEY, LANGFLOW_BASE_URL } from "@/lib/config";

const DEFAULT_TIMEOUT_MS = 55_000;

type RunLangflowArgs = {
  flowId: string;
  input: string;
  tweaks?: Record<string, unknown>;
  sessionId?: string;
  timeoutMs?: number;
};

// Langflow's run envelope nests the ChatOutput message a few levels deep, and
// the key has shifted across versions (message.text vs message.data.text).
// Both shapes are checked so a minor Langflow upgrade doesn't silently break extraction.
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
          // HF Spaces gates on x-api-key; some proxies on Authorization, send both.
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

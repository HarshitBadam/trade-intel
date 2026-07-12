import "server-only";

import { GROQ_API_KEY } from "@/lib/config";
import { parseFencedJson } from "@/lib/llm-json";

const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const REQUEST_TIMEOUT_MS = 20_000;

const MAX_RETRY_WAIT_MS = 5_000;

const DEFAULT_TEMPERATURE = 0.2;

export type GroqMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type GroqChatArgs = {
  model: string;
  system?: string;
  user?: string;
  messages?: GroqMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

function composeMessages(args: GroqChatArgs): GroqMessage[] {
  return [
    ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
    ...(args.messages ?? []),
    ...(args.user ? [{ role: "user" as const, content: args.user }] : []),
  ];
}

type GroqCompletion = {
  choices?: { message?: { content?: string } }[];
};

export class GroqRequestError extends Error {
  status?: number;
  retryAfterMs?: number;

  constructor(
    message: string,
    options?: { status?: number; retryAfterMs?: number; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "GroqRequestError";
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durationMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const units = [...value.matchAll(/([\d.]+)\s*(ms|s|m|h)/gi)];
  if (units.length > 0) {
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
    };
    const total = units.reduce(
      (sum, match) =>
        sum + Number(match[1]) * (multipliers[match[2].toLowerCase()] ?? 0),
      0
    );
    if (Number.isFinite(total)) return Math.ceil(total);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryAfterMs(response: Response): number {
  return (
    durationMs(response.headers.get("retry-after")) ??
    durationMs(response.headers.get("x-ratelimit-reset-tokens")) ??
    MAX_RETRY_WAIT_MS
  );
}

async function postChatCompletion(
  args: GroqChatArgs,
  jsonMode: boolean
): Promise<Response> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured");
  }
  return fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: composeMessages(args),
      temperature: args.temperature ?? DEFAULT_TEMPERATURE,
      ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
      ...(args.model.startsWith("openai/gpt-oss")
        ? { reasoning_effort: "low", include_reasoning: false }
        : {}),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
}

async function groqChatRaw(
  args: GroqChatArgs,
  jsonMode: boolean
): Promise<string> {
  let response: Response;
  try {
    response = await postChatCompletion(args, jsonMode);
  } catch (error) {
    throw new GroqRequestError("Groq request did not complete", {
      cause: error,
    });
  }

  if (response.status === 429 || response.status >= 500) {
    const waitMs =
      response.status === 429
        ? retryAfterMs(response)
        : 250 + Math.round(Math.random() * 250);
    if (waitMs <= MAX_RETRY_WAIT_MS) {
      await sleep(waitMs + Math.round(Math.random() * 150));
      try {
        response = await postChatCompletion(args, jsonMode);
      } catch (error) {
        throw new GroqRequestError("Groq retry did not complete", {
          cause: error,
          status: response.status,
          retryAfterMs: waitMs,
        });
      }
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GroqRequestError(
      `groq request failed with ${response.status}` +
        (body ? `: ${body.slice(0, 500)}` : ""),
      {
        status: response.status,
        retryAfterMs:
          response.status === 429 ? retryAfterMs(response) : undefined,
      }
    );
  }

  const data = (await response.json()) as GroqCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new GroqRequestError("Groq returned an empty completion");
  }
  return content;
}

export function shouldTripGroqCircuit(error: unknown): boolean {
  if (!(error instanceof GroqRequestError)) return true;
  if (error.status === 429) return false;
  if (typeof error.status === "number" && error.status < 500) return false;
  return true;
}

export function groqErrorSummary(error: unknown): {
  name: string;
  status?: number;
  retryAfterMs?: number;
} {
  if (error instanceof GroqRequestError) {
    return {
      name: error.name,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return { name: error instanceof Error ? error.name : "unknown" };
}

export async function groqChatJSON<T = unknown>(
  args: GroqChatArgs
): Promise<T> {
  const raw = await groqChatRaw(args, true);
  return parseFencedJson<T>(raw);
}

export async function groqChatText(args: GroqChatArgs): Promise<string> {
  return groqChatRaw(args, false);
}

import "server-only";

import {
  CEREBRAS_API_KEY,
  GROQ_API_KEY,
  hasCerebras,
  hasGroq,
} from "@/lib/config";
import { parseFencedJson } from "@/lib/llm-json";

export type LlmVendor = "groq" | "cerebras";

const REQUEST_TIMEOUT_MS = 20_000;

const MAX_RETRY_WAIT_MS = 5_000;

const DEFAULT_TEMPERATURE = 0.2;

const ENDPOINTS: Record<LlmVendor, { url: string; key: () => string | undefined }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: () => GROQ_API_KEY,
  },
  cerebras: {
    url: "https://api.cerebras.ai/v1/chat/completions",
    key: () => CEREBRAS_API_KEY,
  },
};

export function hasVendor(vendor: LlmVendor): boolean {
  return vendor === "cerebras" ? hasCerebras : hasGroq;
}

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmChatArgs = {
  vendor: LlmVendor;
  model: string;
  system?: string;
  user?: string;
  messages?: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
};

function composeMessages(args: LlmChatArgs): LlmMessage[] {
  return [
    ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
    ...(args.messages ?? []),
    ...(args.user ? [{ role: "user" as const, content: args.user }] : []),
  ];
}

type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
};

export class LlmRequestError extends Error {
  vendor?: LlmVendor;
  status?: number;
  retryAfterMs?: number;

  constructor(
    message: string,
    options?: {
      vendor?: LlmVendor;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "LlmRequestError";
    this.vendor = options?.vendor;
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

// Groq-hosted gpt-oss and Qwen models need explicit reasoning controls.
function reasoningParams(args: LlmChatArgs): Record<string, unknown> {
  if (args.vendor === "cerebras") {
    return /\bgpt-oss\b/.test(args.model)
      ? { reasoning_effort: "low" }
      : {};
  }
  if (/\bqwen\b/.test(args.model)) {
    return { reasoning_effort: "none", include_reasoning: false };
  }
  if (!/\bgpt-oss\b/.test(args.model)) return {};
  return { reasoning_effort: "low", include_reasoning: false };
}

async function postChatCompletion(
  args: LlmChatArgs,
  jsonMode: boolean
): Promise<Response> {
  const endpoint = ENDPOINTS[args.vendor];
  const apiKey = endpoint.key();
  if (!apiKey) {
    throw new LlmRequestError(`${args.vendor} API key is not configured`, {
      vendor: args.vendor,
    });
  }
  return fetch(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: composeMessages(args),
      temperature: args.temperature ?? DEFAULT_TEMPERATURE,
      ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
      ...reasoningParams(args),
      ...(jsonMode
        ? {
            response_format: args.jsonSchema
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: args.jsonSchema.name,
                    strict: args.jsonSchema.strict ?? true,
                    schema: args.jsonSchema.schema,
                  },
                }
              : { type: "json_object" },
          }
        : {}),
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
}

async function llmChatRaw(args: LlmChatArgs, jsonMode: boolean): Promise<string> {
  let response: Response;
  try {
    response = await postChatCompletion(args, jsonMode);
  } catch (error) {
    if (error instanceof LlmRequestError) throw error;
    throw new LlmRequestError(`${args.vendor} request did not complete`, {
      vendor: args.vendor,
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
        throw new LlmRequestError(`${args.vendor} retry did not complete`, {
          vendor: args.vendor,
          cause: error,
          status: response.status,
          retryAfterMs: waitMs,
        });
      }
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LlmRequestError(
      `${args.vendor} request failed with ${response.status}` +
        (body ? `: ${body.slice(0, 500)}` : ""),
      {
        vendor: args.vendor,
        status: response.status,
        retryAfterMs:
          response.status === 429 ? retryAfterMs(response) : undefined,
      }
    );
  }

  const data = (await response.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new LlmRequestError(`${args.vendor} returned an empty completion`, {
      vendor: args.vendor,
    });
  }
  return content;
}

export function shouldTripLlmCircuit(error: unknown): boolean {
  if (!(error instanceof LlmRequestError)) return true;
  if (error.status === 429) return false;
  if (typeof error.status === "number" && error.status < 500) return false;
  return true;
}

export function llmErrorSummary(error: unknown): {
  name: string;
  vendor?: LlmVendor;
  status?: number;
  retryAfterMs?: number;
} {
  if (error instanceof LlmRequestError) {
    return {
      name: error.name,
      vendor: error.vendor,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return { name: error instanceof Error ? error.name : "unknown" };
}

export async function llmChatJSON<T = unknown>(args: LlmChatArgs): Promise<T> {
  const raw = await llmChatRaw(args, true);
  return parseFencedJson<T>(raw);
}

export async function llmChatText(args: LlmChatArgs): Promise<string> {
  return llmChatRaw(args, false);
}

import "server-only";

import {
  CEREBRAS_API_KEY,
  GROQ_API_KEY,
  hasCerebras,
  hasGroq,
} from "@/lib/config";
import { parseFencedJson } from "./llm-json";

export type LlmVendor = "groq" | "cerebras";
export type LlmReasoningEffort = "none" | "low" | "medium" | "high";

const REQUEST_TIMEOUT_MS = 20_000;

const MAX_LLM_RETRIES = 2;
const MAX_TOTAL_RETRY_WAIT_MS = 10_000;
const DEFAULT_RATE_LIMIT_RETRY_MS = 2_000;

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
  reasoningEffort?: LlmReasoningEffort;
  timeoutMs?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
};

export type LlmTransportDependencies = {
  fetchImpl?: typeof fetch;
  apiKey?: (vendor: LlmVendor) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
};

function composeMessages(args: LlmChatArgs): LlmMessage[] {
  return [
    ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
    ...(args.messages ?? []),
    ...(args.user ? [{ role: "user" as const, content: args.user }] : []),
  ];
}

function messagesForMode(args: LlmChatArgs, jsonMode: boolean): LlmMessage[] {
  const messages = composeMessages(args);
  if (!jsonMode) return messages;

  const jsonInstruction = args.jsonSchema
    ? "Return valid JSON matching the requested response schema only."
    : "Return one valid JSON object only.";
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: jsonInstruction }, ...messages];
  }
  return messages.map((message, index) =>
    index === systemIndex
      ? {
          ...message,
          content:
            message.content.trim().length > 0
              ? `${message.content}\n${jsonInstruction}`
              : jsonInstruction,
        }
      : message
  );
}

type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
};

async function completionContent(response: Response): Promise<string | undefined> {
  const data = (await response.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() !== ""
    ? content
    : undefined;
}

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
    DEFAULT_RATE_LIMIT_RETRY_MS
  );
}

// Groq-hosted gpt-oss and Qwen models need explicit reasoning controls.
function reasoningParams(args: LlmChatArgs): Record<string, unknown> {
  if (args.vendor === "cerebras") {
    return /\bgpt-oss\b/.test(args.model)
      ? { reasoning_effort: args.reasoningEffort ?? "low" }
      : {};
  }
  if (/\bqwen\b/.test(args.model)) {
    return { reasoning_effort: "none", include_reasoning: false };
  }
  if (!/\bgpt-oss\b/.test(args.model)) return {};
  return {
    reasoning_effort: args.reasoningEffort ?? "low",
    include_reasoning: false,
  };
}

export function buildLlmRequestBody(
  args: LlmChatArgs,
  jsonMode: boolean
): Record<string, unknown> {
  return {
    model: args.model,
    messages: messagesForMode(args, jsonMode),
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
  };
}

async function postChatCompletion(
  args: LlmChatArgs,
  jsonMode: boolean,
  dependencies: LlmTransportDependencies
): Promise<Response> {
  const endpoint = ENDPOINTS[args.vendor];
  const apiKey = dependencies.apiKey
    ? dependencies.apiKey(args.vendor)
    : endpoint.key();
  if (!apiKey) {
    throw new LlmRequestError(`${args.vendor} API key is not configured`, {
      vendor: args.vendor,
    });
  }
  return (dependencies.fetchImpl ?? fetch)(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildLlmRequestBody(args, jsonMode)),
    signal: AbortSignal.timeout(args.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
}

async function llmChatRaw(
  args: LlmChatArgs,
  jsonMode: boolean,
  dependencies: LlmTransportDependencies = {}
): Promise<string> {
  let response: Response | undefined;
  let totalRetryWaitMs = 0;
  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
    try {
      response = await postChatCompletion(args, jsonMode, dependencies);
    } catch (error) {
      if (error instanceof LlmRequestError) throw error;
      throw new LlmRequestError(`${args.vendor} request did not complete`, {
        vendor: args.vendor,
        cause: error,
      });
    }
    const retryableStatus = response.status === 429 || response.status >= 500;
    if (!retryableStatus || attempt === MAX_LLM_RETRIES) break;
    const baseWaitMs =
      response.status === 429
        ? retryAfterMs(response)
        : 250 * 2 ** attempt;
    const waitMs = baseWaitMs + Math.round(Math.random() * 150);
    if (
      baseWaitMs > MAX_TOTAL_RETRY_WAIT_MS ||
      totalRetryWaitMs + waitMs > MAX_TOTAL_RETRY_WAIT_MS
    ) {
      break;
    }
    totalRetryWaitMs += waitMs;
    await (dependencies.sleep ?? sleep)(waitMs);
  }
  if (!response) {
    throw new LlmRequestError(`${args.vendor} request did not complete`, {
      vendor: args.vendor,
    });
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

  const content = await completionContent(response);
  if (content) return content;

  // Some OpenAI-compatible providers occasionally return a successful response
  // whose reasoning consumed the completion budget before any visible content.
  // Treat that as transient once, rather than surfacing an internal transport
  // failure to the user.
  await (dependencies.sleep ?? sleep)(100);
  const retry = await postChatCompletion(args, jsonMode, dependencies);
  if (!retry.ok) {
    throw new LlmRequestError(
      `${args.vendor} empty-completion retry failed with ${retry.status}`,
      {
        vendor: args.vendor,
        status: retry.status,
        retryAfterMs: retry.status === 429 ? retryAfterMs(retry) : undefined,
      }
    );
  }
  const retriedContent = await completionContent(retry);
  if (retriedContent) return retriedContent;
  throw new LlmRequestError(`${args.vendor} returned an empty completion`, {
    vendor: args.vendor,
  });
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

export async function llmChatJSON<T = unknown>(
  args: LlmChatArgs,
  dependencies: LlmTransportDependencies = {}
): Promise<T> {
  const raw = await llmChatRaw(args, true, dependencies);
  return parseFencedJson<T>(raw);
}

export async function llmChatText(
  args: LlmChatArgs,
  dependencies: LlmTransportDependencies = {}
): Promise<string> {
  return llmChatRaw(args, false, dependencies);
}

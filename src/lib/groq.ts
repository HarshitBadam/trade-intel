import "server-only";

import { GROQ_API_KEY } from "@/lib/config";
import { parseFencedJson } from "@/lib/llm-json";

// Plain-fetch Groq client (OpenAI-compatible Chat Completions). Deliberately no
// SDK: the surface we need is a single POST, and the redesign keeps the LLM
// transport swappable (D7/D10 — Task 6 puts a Langflow flow in FRONT of the
// same analysis engine), so one thin, dependency-free client is the cleanest
// seam and the least to reason about when it fails.

const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";

// Groq's LPU is fast, but a cold model or a long completion can still run for a
// while; 60s is generous headroom over the few-second norm without letting a
// caller (cron/priority lane) hang indefinitely on a wedged request.
const REQUEST_TIMEOUT_MS = 60_000;

// A 429 with a SHORT retry-after is a transient burst worth waiting out once; a
// long one means the per-minute/day bucket is genuinely spent, so we throw and
// let the caller move on rather than block a serverless invocation for minutes.
const MAX_RETRY_WAIT_MS = 20_000;

// Low but non-zero: analysis wants stable, near-deterministic labels, not
// creativity. Callers can override for a chattier lane (Task 6's chat fallback).
const DEFAULT_TEMPERATURE = 0.2;

type GroqChatArgs = {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
};

type GroqCompletion = {
  choices?: { message?: { content?: string } }[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq reports retry-after in seconds (sometimes fractional). Fall back to the
// max budget when the header is absent so a retry still paces itself instead of
// hammering immediately.
function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  return MAX_RETRY_WAIT_MS;
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
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      temperature: args.temperature ?? DEFAULT_TEMPERATURE,
      ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// One call with a single retry on a short-enough 429. Returns the raw assistant
// message content; typing/parsing is the caller's concern.
async function groqChatRaw(
  args: GroqChatArgs,
  jsonMode: boolean
): Promise<string> {
  let response = await postChatCompletion(args, jsonMode);

  if (response.status === 429) {
    const waitMs = retryAfterMs(response);
    if (waitMs > MAX_RETRY_WAIT_MS) {
      throw new Error(
        `groq rate-limited (429): retry-after ~${Math.round(waitMs / 1000)}s ` +
          `exceeds the ${MAX_RETRY_WAIT_MS / 1000}s single-retry budget`
      );
    }
    await sleep(waitMs);
    response = await postChatCompletion(args, jsonMode);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `groq request failed with ${response.status}` +
        (body ? `: ${body.slice(0, 500)}` : "")
    );
  }

  const data = (await response.json()) as GroqCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("groq returned an empty completion");
  }
  return content;
}

// Structured call: forces JSON mode and returns the parsed object. Callers pass
// the expected shape via <T> and are responsible for validating it (we make no
// guarantees about the model's adherence to a schema beyond "it's JSON"). The
// fence-stripping parse is shared with the Langflow lane (see lib/llm-json.ts).
export async function groqChatJSON<T = unknown>(
  args: GroqChatArgs
): Promise<T> {
  const raw = await groqChatRaw(args, true);
  return parseFencedJson<T>(raw);
}

// Plain-text call. Unused today; exported now so the client is complete for
// Task 6's chat fallback (which wants prose, not JSON).
export async function groqChatText(args: GroqChatArgs): Promise<string> {
  return groqChatRaw(args, false);
}

import "server-only";

import {
  CEREBRAS_CHAT_MODEL,
  GEMINI_CHAT_MODEL,
  GROQ_ANALYSIS_MODEL,
  GROQ_CHAT_MODEL,
  GROQ_FALLBACK_MODEL,
  GROQ_OSS_MODEL,
  hasAnySynthesisLlm,
} from "@/lib/config";
import {
  hasVendor,
  llmChatText,
  llmErrorSummary,
  shouldTripLlmCircuit,
  type LlmMessage,
  type LlmVendor,
} from "@/lib/llm";
import {
  isCoolingDown,
  isOpen,
  recordCooldown,
  recordFailure,
  recordUnavailable,
  recordSuccess,
  type Provider,
} from "@/lib/breaker";
import { rateLimit } from "@/lib/rate-limit";

type SynthesisArgs = {
  system: string;
  user: string;
  history?: LlmMessage[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  event: "regular_synthesis" | "deep_synthesis" | "social_synthesis";
  lane?: "full" | "light";
  accept?: (text: string) => boolean;
  correction?: string | ((draft: string) => string);
};

const laneTails = new Map<string, Promise<void>>();

async function acquireLane(
  lane: string,
  waitMs: number
): Promise<(() => void) | null> {
  const previous = laneTails.get(lane) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  laneTails.set(lane, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, waitMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  const finish = () => {
    release();
    void tail.finally(() => {
      if (laneTails.get(lane) === tail) laneTails.delete(lane);
    });
  };
  if (!acquired) {
    finish();
    return null;
  }
  return finish;
}

type Candidate = {
  vendor: LlmVendor;
  model: string;
  provider: Provider;
  quotaProvider: Provider;
  budgetPerMinute: number;
  // Cerebras free tier caps context at ~8K tokens; skip it for oversized prompts.
  maxPromptChars?: number;
};

function candidatesFor(args: SynthesisArgs): Candidate[] {
  const deep = args.event === "deep_synthesis";
  const groqPrimary: Candidate = {
    vendor: "groq",
    model: GROQ_CHAT_MODEL,
    provider: deep ? "groq-deep" : "groq-chat",
    quotaProvider: "groq-chat",
    budgetPerMinute: 12,
  };
  const cerebras: Candidate = {
    vendor: "cerebras",
    model: CEREBRAS_CHAT_MODEL,
    provider: deep ? "cerebras-deep" : "cerebras-chat",
    quotaProvider: "cerebras-chat",
    budgetPerMinute: 10,
    maxPromptChars: 20_000,
  };
  const gemini: Candidate = {
    vendor: "gemini",
    model: GEMINI_CHAT_MODEL,
    provider: deep ? "gemini-deep" : "gemini-chat",
    quotaProvider: "gemini-chat",
    budgetPerMinute: 8,
  };
  const groqFallback: Candidate = {
    vendor: "groq",
    model: GROQ_FALLBACK_MODEL,
    provider: deep ? "groq-deep-fallback" : "groq-fallback",
    quotaProvider: "groq-fallback",
    budgetPerMinute: 4,
  };
  // Groq rate limits are per model, so this rides a separate 429 budget from
  // the scout/70b lanes.
  const groqOss: Candidate = {
    vendor: "groq",
    model: GROQ_OSS_MODEL,
    provider: deep ? "groq-deep-oss" : "groq-oss",
    quotaProvider: "groq-oss",
    budgetPerMinute: 10,
  };
  const groqSmall: Candidate = {
    vendor: "groq",
    model: GROQ_ANALYSIS_MODEL,
    provider: deep ? "groq-deep-small" : "groq-chat-small",
    quotaProvider: "groq-analysis",
    budgetPerMinute: 20,
  };
  const ordered =
    args.lane === "light"
      ? [groqPrimary, gemini, cerebras, groqOss, groqSmall, groqFallback]
      : [groqPrimary, cerebras, gemini, groqOss, groqFallback, groqSmall];
  return ordered.filter(
    (candidate, index, list) =>
      hasVendor(candidate.vendor) &&
      list.findIndex(
        (other) =>
          other.vendor === candidate.vendor && other.model === candidate.model
      ) === index
  );
}

function promptChars(args: SynthesisArgs): number {
  return (
    args.system.length +
    args.user.length +
    (args.history ?? []).reduce((sum, turn) => sum + turn.content.length, 0)
  );
}

export async function synthesizeWithFallback(
  args: SynthesisArgs
): Promise<string> {
  if (!hasAnySynthesisLlm) throw new Error("No synthesis LLM is configured");

  let lastError: unknown;
  const deadline = Date.now() + (args.totalTimeoutMs ?? 30_000);
  const inputChars = promptChars(args);

  for (const candidate of candidatesFor(args)) {
    if (
      candidate.maxPromptChars !== undefined &&
      inputChars > candidate.maxPromptChars
    ) {
      continue;
    }
    const laneKey = `${candidate.vendor}:${candidate.model}`;
    const release = await acquireLane(laneKey, deadline - Date.now());
    if (!release) break;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) continue;
      if (
        (await isOpen(candidate.provider)) ||
        (await isOpen(candidate.quotaProvider)) ||
        (await isCoolingDown(candidate.quotaProvider))
      ) {
        continue;
      }
      const admission = await rateLimit(
        `stocksage-model-${laneKey.replace(/[^a-z0-9]+/gi, "-")}`,
        "shared-synthesis-budget",
        candidate.budgetPerMinute,
        60
      );
      if (!admission.success) continue;
      const base = {
        vendor: candidate.vendor,
        model: candidate.model,
        system: args.system,
        messages: args.history,
        maxTokens: args.maxTokens,
        temperature: args.temperature ?? 0.5,
      };
      const text = await llmChatText({
        ...base,
        user: args.user,
        timeoutMs: Math.min(args.timeoutMs ?? 20_000, remainingMs),
      });
      await recordSuccess(candidate.provider);
      if (!args.accept || args.accept(text)) return text;

      if (args.correction && deadline - Date.now() > 2_000) {
        const correction =
          typeof args.correction === "function"
            ? args.correction(text)
            : args.correction;
        const revised = await llmChatText({
          ...base,
          messages: [
            ...(args.history ?? []),
            { role: "user", content: args.user },
            { role: "assistant", content: text },
            { role: "user", content: correction },
          ],
          user: undefined,
          timeoutMs: Math.min(args.timeoutMs ?? 20_000, deadline - Date.now()),
        });
        if (args.accept(revised)) return revised;
      }
      lastError = new Error("Synthesis output failed publication checks");
      console.error(
        `[stocksage] ${JSON.stringify({
          event: args.event,
          provider: candidate.provider,
          model: candidate.model,
          name: "SynthesisValidationError",
        })}`
      );
      continue;
    } catch (error) {
      lastError = error;
      const summary = llmErrorSummary(error);
      if (summary.status === 429) {
        await recordCooldown(
          candidate.quotaProvider,
          summary.retryAfterMs ?? 60_000
        );
      }
      if (summary.status === 404) {
        await recordUnavailable(candidate.quotaProvider);
      } else if (shouldTripLlmCircuit(error)) {
        await recordFailure(candidate.provider);
      }
      console.error(
        `[stocksage] ${JSON.stringify({
          event: args.event,
          provider: candidate.provider,
          model: candidate.model,
          ...summary,
        })}`
      );
    } finally {
      release();
    }
  }

  throw lastError ?? new Error("All configured synthesis models are unavailable");
}

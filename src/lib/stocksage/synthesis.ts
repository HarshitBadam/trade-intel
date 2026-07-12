import "server-only";

import {
  GROQ_ANALYSIS_MODEL,
  GROQ_CHAT_MODEL,
  GROQ_FALLBACK_MODEL,
  hasGroq,
} from "@/lib/config";
import {
  groqChatText,
  groqErrorSummary,
  shouldTripGroqCircuit,
  type GroqMessage,
} from "@/lib/groq";
import {
  isCoolingDown,
  isOpen,
  recordCooldown,
  recordFailure,
  recordSuccess,
  type Provider,
} from "@/lib/breaker";
import { rateLimit } from "@/lib/rate-limit";

type SynthesisArgs = {
  system: string;
  user: string;
  history?: GroqMessage[];
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
  model: string;
  provider: Provider;
  quotaProvider: Provider;
  budgetPerMinute: number;
};

function candidatesFor(args: SynthesisArgs): Candidate[] {
  const deep = args.event === "deep_synthesis";
  const primary: Candidate = {
    model: GROQ_CHAT_MODEL,
    provider: deep ? "groq-deep" : "groq-chat",
    quotaProvider: "groq-chat",
    budgetPerMinute: 12,
  };
  const fallback: Candidate = {
    model: GROQ_FALLBACK_MODEL,
    provider: deep ? "groq-deep-fallback" : "groq-fallback",
    quotaProvider: "groq-fallback",
    budgetPerMinute: 4,
  };
  const small: Candidate = {
    model: GROQ_ANALYSIS_MODEL,
    provider: deep ? "groq-deep-small" : "groq-chat-small",
    quotaProvider: "groq-analysis",
    budgetPerMinute: 20,
  };
  const ordered =
    args.lane === "light"
      ? [primary, small, fallback]
      : [primary, fallback, small];
  return ordered.filter(
    (candidate, index, list) =>
      list.findIndex((other) => other.model === candidate.model) === index
  );
}

export async function synthesizeWithFallback(
  args: SynthesisArgs
): Promise<string> {
  if (!hasGroq) throw new Error("Groq synthesis is not configured");

  let lastError: unknown;
  const deadline = Date.now() + (args.totalTimeoutMs ?? 30_000);

  for (const candidate of candidatesFor(args)) {
    const release = await acquireLane(candidate.model, deadline - Date.now());
    if (!release) break;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) continue;
      if (
        (await isOpen(candidate.provider)) ||
        (await isCoolingDown(candidate.quotaProvider))
      ) {
        continue;
      }
      const admission = await rateLimit(
        `stocksage-model-${candidate.model.replace(/[^a-z0-9]+/gi, "-")}`,
        "shared-synthesis-budget",
        candidate.budgetPerMinute,
        60
      );
      if (!admission.success) continue;
      const base = {
        model: candidate.model,
        system: args.system,
        messages: args.history,
        maxTokens: args.maxTokens,
        temperature: args.temperature ?? 0.5,
      };
      const text = await groqChatText({
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
        const revised = await groqChatText({
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
      const summary = groqErrorSummary(error);
      if (summary.status === 429) {
        await recordCooldown(
          candidate.quotaProvider,
          summary.retryAfterMs ?? 60_000
        );
      }
      if (shouldTripGroqCircuit(error)) {
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

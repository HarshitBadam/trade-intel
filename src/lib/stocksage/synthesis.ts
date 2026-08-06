import "server-only";

import {
  GROQ_CHAT_MODEL,
  GROQ_FALLBACK_MODEL,
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
  event: "regular_synthesis" | "deep_synthesis";
  lane?: "full" | "light";
  accept?: (text: string) => boolean;
  correction?: string | ((draft: string) => string);
  maxCandidates?: number;
  /** Deep Research uses exactly its configured primary, plus one repair. */
  modelAttempts?: "primary_only" | "primary_then_fallback";
};

const laneTails = new Map<string, Promise<void>>();
const LANE_WAIT_CEILING_MS = 250;

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
};

/**
 * The unified engine resolves exactly one Groq primary and one configured
 * Groq fallback at startup — never a longer per-vendor failover chain. Both
 * regular chat and Deep Research share this same two-candidate pool;
 * `maxCandidates` (capped at 2 by every caller) is what actually bounds a
 * single request to at most one primary plus one fallback attempt.
 */
function candidatesFor(args: SynthesisArgs): Candidate[] {
  const deep = args.event === "deep_synthesis";
  const groqPrimary: Candidate = {
    vendor: "groq",
    model: GROQ_CHAT_MODEL,
    provider: deep ? "groq-deep" : "groq-chat",
    quotaProvider: "groq-chat",
    budgetPerMinute: 12,
  };
  const groqFallback: Candidate = {
    vendor: "groq",
    model: GROQ_FALLBACK_MODEL,
    provider: deep ? "groq-deep-fallback" : "groq-fallback",
    quotaProvider: "groq-fallback",
    budgetPerMinute: 4,
  };
  const ordered = [groqPrimary, groqFallback];
  const selected =
    args.modelAttempts === "primary_only" ? ordered.slice(0, 1) : ordered;
  return selected.filter(
    (candidate, index, list) =>
      hasVendor(candidate.vendor) &&
      list.findIndex(
        (other) =>
          other.vendor === candidate.vendor && other.model === candidate.model
      ) === index
  );
}

export async function synthesizeWithFallback(
  args: SynthesisArgs
): Promise<string> {
  if (!hasAnySynthesisLlm) throw new Error("No synthesis LLM is configured");

  let lastError: unknown;
  const deadline = Date.now() + (args.totalTimeoutMs ?? 30_000);
  let attemptedCandidates = 0;
  let repairAttempted = false;

  for (const candidate of candidatesFor(args)) {
    const laneKey = `${candidate.vendor}:${candidate.model}:${args.lane ?? "full"}`;
    const release = await acquireLane(
      laneKey,
      Math.min(
        LANE_WAIT_CEILING_MS,
        Math.max(0, deadline - Date.now() - 1_000)
      )
    );
    // A saturated primary lane is candidate-local unavailability. The
    // configured fallback has its own lane and must still get a chance.
    if (!release) continue;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) continue;
      const providerOpen = await isOpen(candidate.provider);
      const quotaOpen =
        candidate.quotaProvider === candidate.provider
          ? providerOpen
          : await isOpen(candidate.quotaProvider);
      if (
        providerOpen ||
        quotaOpen ||
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
      if (attemptedCandidates >= (args.maxCandidates ?? Number.POSITIVE_INFINITY)) {
        break;
      }
      attemptedCandidates += 1;
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
      // Breaker success records provider/API availability. A draft rejected by
      // publication checks is valid transport and must not trip the circuit.
      await recordSuccess(candidate.provider);
      if (!args.accept || args.accept(text)) return text;

      if (
        args.correction &&
        !repairAttempted &&
        deadline - Date.now() > 2_000
      ) {
        const repairProviderOpen = await isOpen(candidate.provider);
        const repairQuotaOpen =
          candidate.quotaProvider === candidate.provider
            ? repairProviderOpen
            : await isOpen(candidate.quotaProvider);
        const repairAdmission =
          !repairProviderOpen &&
          !repairQuotaOpen &&
          !(await isCoolingDown(candidate.quotaProvider)) &&
          (await rateLimit(
            `stocksage-model-${laneKey.replace(/[^a-z0-9]+/gi, "-")}`,
            "shared-synthesis-budget",
            candidate.budgetPerMinute,
            60
          )).success;
        if (repairAdmission && deadline - Date.now() > 1_000) {
          // A repair is a separate admitted transport call, but it is still
          // globally limited to one invocation for this synthesis request.
          repairAttempted = true;
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
            timeoutMs: Math.min(
              args.timeoutMs ?? 20_000,
              deadline - Date.now()
            ),
          });
          await recordSuccess(candidate.provider);
          if (args.accept(revised)) return revised;
        }
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

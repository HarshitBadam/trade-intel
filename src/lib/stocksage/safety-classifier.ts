import "server-only";

import {
  isCoolingDown,
  isOpen,
  recordCooldown,
  recordFailure,
  recordSuccess,
  recordUnavailable,
} from "@/lib/breaker";
import { GROQ_SAFETY_MODEL, hasSafetyClassifier } from "@/lib/config";
import {
  llmChatText,
  llmErrorSummary,
  shouldTripLlmCircuit,
} from "@/lib/llm";
import { rateLimit } from "@/lib/rate-limit";
import type { CrisisKind } from "./crisis";

export type SafetyVerdict =
  | { action: "allow" }
  | { action: "crisis"; kind: CrisisKind; categories: string[] }
  | { action: "refuse"; categories: string[] };

export type SafetyClassifier = (message: string) => Promise<SafetyVerdict>;

const ALLOW: SafetyVerdict = { action: "allow" };

const CRISIS_CATEGORY = "S11";

// MLCommons hazard codes acted on as refusals. S6 (Specialized Advice) and S2
// (Non-Violent Crimes) are deliberately absent: they fire on ordinary
// investment questions and on analysis of financial crime as a subject, which
// is what this product exists to do. Genuine misconduct facilitation is
// refused deterministically in policy.ts.
const REFUSED_CATEGORIES = new Set(["S3", "S4", "S9"]);

const DEADLINE_MS = 1_500;
const REQUESTS_PER_MINUTE = 60;

// Codes are read from the whole response rather than the lines after the
// verdict: the documented shape is newline-separated, but a same-line "unsafe
// S11" must not be parsed as a clean bill of health.
export function parseGuardVerdict(raw: string): SafetyVerdict {
  if (!/^\s*unsafe\b/i.test(raw)) return ALLOW;
  const categories = [
    ...new Set(raw.toUpperCase().match(/\bS\d{1,2}\b/g) ?? []),
  ];
  if (categories.includes(CRISIS_CATEGORY)) {
    return { action: "crisis", kind: "self_harm", categories };
  }
  const refused = categories.filter((code) => REFUSED_CATEGORIES.has(code));
  return refused.length > 0 ? { action: "refuse", categories: refused } : ALLOW;
}

// Every path out of here resolves to a verdict, and every failure resolves to
// allow: the regex prefilter in crisis.ts is the layer that must always hold,
// and a classifier outage must never take chat down.
export async function classifyInputSafety(
  message: string
): Promise<SafetyVerdict> {
  if (!hasSafetyClassifier) return ALLOW;
  try {
    if ((await isOpen("groq-guard")) || (await isCoolingDown("groq-guard"))) {
      return ALLOW;
    }
    const admission = await rateLimit(
      "stocksage-safety-guard",
      "shared-guard-budget",
      REQUESTS_PER_MINUTE,
      60
    );
    if (!admission.success) return ALLOW;
    // Guard accuracy degrades on long context, so only the current turn is
    // scored; conversation history is not sent.
    const raw = await llmChatText({
      vendor: "groq",
      model: GROQ_SAFETY_MODEL,
      user: message,
      maxTokens: 16,
      temperature: 0,
      timeoutMs: DEADLINE_MS,
    });
    await recordSuccess("groq-guard");
    return parseGuardVerdict(raw);
  } catch (error) {
    const summary = llmErrorSummary(error);
    if (summary.status === 429) {
      await recordCooldown("groq-guard", summary.retryAfterMs ?? 60_000);
    } else if (summary.status === 404) {
      await recordUnavailable("groq-guard");
    } else if (shouldTripLlmCircuit(error)) {
      await recordFailure("groq-guard");
    }
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "safety_classifier_unavailable",
        ...summary,
      })}`
    );
    return ALLOW;
  }
}

export function beginInputSafetyCheck(
  message: string,
  classifier: SafetyClassifier = classifyInputSafety
): Promise<SafetyVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const verdict = Promise.resolve()
    .then(() => classifier(message))
    .catch(() => ALLOW);
  return Promise.race([
    verdict,
    new Promise<SafetyVerdict>((resolve) => {
      timer = setTimeout(() => resolve(ALLOW), DEADLINE_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

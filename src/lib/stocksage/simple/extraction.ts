import { ZodError } from "zod";
import { llmErrorSummary } from "@/lib/llm";
import { logStockSage } from "@/lib/telemetry";
import type { ChatRequest } from "../types";
import type {
  ContextualRecoveryHints,
  ContextualRecoveryResult,
  SimpleEvidencePlan,
} from "./contracts";
import {
  contextualRecoveryContext,
  isUnambiguousMarketWideRankingTurn,
  semanticContext,
} from "./context";
import {
  ContextualRecoverySchema,
  deterministicRankingSeeds,
  salvageEvidencePlan,
} from "./extraction-helpers";
import {
  CONTEXTUAL_RECOVERY_SYSTEM_PROMPT,
  extractionSystemPrompt,
} from "./extraction-prompt";
import {
  isRecoverableLlmTransportFailure,
  simpleLlmChatJSON,
  type SimpleJsonCall,
} from "./llm";
import {
  hasSimpleEvidenceRequest,
  normalizeSimpleEvidencePlan,
  summarizeZodIssues,
} from "./validation";

export async function recoverContextualEvidencePlan(
  request: ChatRequest,
  now = new Date(),
  jsonCall: SimpleJsonCall = simpleLlmChatJSON,
  hints: ContextualRecoveryHints = { resolvedCurrentEntities: [] }
): Promise<ContextualRecoveryResult> {
  const raw = await jsonCall({
    maxTokens: 700,
    temperature: 0,
    timeoutMs: 12_000,
    system: CONTEXTUAL_RECOVERY_SYSTEM_PROMPT,
    user: contextualRecoveryContext(
      request,
      now,
      hints.resolvedCurrentEntities
    ),
  });
  const parsed = ContextualRecoverySchema.parse(raw);
  const plan = normalizeSimpleEvidencePlan(parsed);
  if (parsed.disposition !== "research") {
    return {
      disposition: parsed.disposition,
      plan: { prices: [], news: [], rankings: [] },
    };
  }
  if (!hasSimpleEvidenceRequest(plan)) {
    return {
      disposition: "ambiguous",
      plan,
    };
  }
  logStockSage({
    event: "simple_contextual_recovery",
    reasonCode: "fresh_research_plan",
    detail: JSON.stringify({
      prices: plan.prices.length,
      news: plan.news.length,
      rankings: plan.rankings.length,
    }),
  });
  return { disposition: "research", plan };
}

export async function extractEvidencePlan(
  request: ChatRequest,
  now = new Date(),
  jsonCall: SimpleJsonCall = simpleLlmChatJSON,
  hints: ContextualRecoveryHints = { resolvedCurrentEntities: [] }
): Promise<SimpleEvidencePlan> {
  const args = {
    maxTokens: 800,
    temperature: 0,
    timeoutMs: 12_000,
    system: extractionSystemPrompt(now),
    user: semanticContext(request, now, hints.resolvedCurrentEntities),
  };

  let raw: unknown;
  try {
    raw = await jsonCall(args);
  } catch (error) {
    if (
      !isRecoverableLlmTransportFailure(error) ||
      !isUnambiguousMarketWideRankingTurn(request.message)
    ) {
      throw error;
    }
    logStockSage({
      event: "simple_extraction_recovered",
      reasonCode: "transport_failure_deterministic_ranking",
      detail: JSON.stringify(llmErrorSummary(error)),
    });
    return normalizeSimpleEvidencePlan({
      prices: [],
      news: [],
      rankings: deterministicRankingSeeds(request, now),
    });
  }

  try {
    return normalizeSimpleEvidencePlan(raw);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const salvaged = salvageEvidencePlan(raw, request, now);
    logStockSage({
      event: "simple_extraction_recovered",
      reasonCode: "schema_mismatch_salvaged",
      detail: JSON.stringify({
        ...summarizeZodIssues(error),
        yields: {
          prices: salvaged.prices.length,
          news: salvaged.news.length,
          rankings: salvaged.rankings.length,
        },
      }),
    });
    return salvaged;
  }
}

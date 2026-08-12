import { randomUUID } from "node:crypto";
import { llmErrorSummary } from "@/lib/llm";
import type { ChatReply, ConversationState } from "../types";

const COLLOQUIAL_GREETING =
  /^(?:yo+|hey+|hi+|hello+|sup+|what'?s\s+up|whats\s+up|wass+up|wazz+up)\b(?:[\s,!.?]+\S+){0,4}[\s!.?]*$/i;

export function isColloquialGreeting(message: string): boolean {
  return COLLOQUIAL_GREETING.test(message);
}

export function simpleLlmErrorReply(
  state: ConversationState,
  stage: "semantic extraction" | "answer composition",
  error: unknown
): ChatReply {
  const summary = llmErrorSummary(error);
  const rateLimited = summary.status === 429;
  console.warn(
    "[stocksage]",
    JSON.stringify({
      event: "simple_llm_unavailable",
      stage,
      ...summary,
    })
  );
  return {
    text: rateLimited
      ? "Sorry, StockSage is busy right now. Please try again in a moment."
      : "StockSage could not finish that response. Please try again.",
    live: false,
    kind: "error",
    ...(rateLimited ? { errorCode: "rate_limited" as const } : {}),
    retryable: true,
    responseId: randomUUID(),
    state,
    dataStatus: "unavailable",
    presentationMode: "no_evidence",
    presentationReason: `simple_${stage.replace(/\s+/g, "_")}_failure`,
  };
}

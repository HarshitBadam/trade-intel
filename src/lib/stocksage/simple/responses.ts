import { randomUUID } from "node:crypto";
import { llmErrorSummary } from "@/lib/llm";
import {
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
} from "../policy/social-patterns";
import type { ChatReply, ConversationState } from "../types";

const COLLOQUIAL_GREETING =
  /^(?:yo+|hey+|hi+|hello+|sup+|what'?s\s+up|whats\s+up|wass+up|wazz+up|howdy|g'?day)\b(?:[\s,!.?]+\S+){0,4}[\s!.?]*$/i;

const INTERNATIONAL_GREETINGS = [
  "namaste",
  "nihao",
  "bonjour",
  "hola",
  "ola",
  "salut",
  "hallo",
  "gutentag",
  "ciao",
  "aloha",
  "shalom",
  "salaam",
  "salam",
  "assalamualaikum",
  "konnichiwa",
  "hej",
  "merhaba",
] as const;

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left === right) return true;

  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

export function isColloquialGreeting(message: string): boolean {
  if (COLLOQUIAL_GREETING.test(message)) return true;

  const words =
    message
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .match(/\p{Letter}+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord || words.length > 5) return false;

  const candidates = [firstWord, words.slice(0, 2).join("")];
  return candidates.some((candidate) =>
    INTERNATIONAL_GREETINGS.some(
      (greeting) =>
        candidate === greeting ||
        (candidate.length >= 5 && editDistanceAtMostOne(candidate, greeting))
    )
  );
}

export function simpleSocialReply(message: string): string {
  if (FAREWELL.test(message)) {
    return "Take care. Come back anytime you want to look at a company or market.";
  }
  if (CASUAL_ACKNOWLEDGEMENT.test(message)) {
    return "You’re welcome. Let me know what company or market you want to look at next.";
  }
  return "Hey, good to see you. What company or market should we look at?";
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

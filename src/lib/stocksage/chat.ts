import "server-only";

import { hasAnySynthesisLlm } from "@/lib/config";
import {
  baseConversationState,
  resolveConversationState,
} from "./entities";
import { EXPLICIT_SELF_HARM, normalizeMessage } from "./intent";
import { answerDegraded, answerWithHeuristics } from "./chat-heuristics";
import { answerWithTriage } from "./chat-triage";
import {
  immediateResponse,
  SELF_HARM_RESPONSE,
  type ChatDependencies,
} from "./chat-shared";
import { hardSafetyFloor } from "./policy";
import { triageWithLLM } from "./triage";
import type { ChatReply, ChatRequest } from "./types";

export async function answerChat(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const normalized = normalizeMessage(request.message);
  const scoped: ChatRequest = { ...request, message: normalized };

  if (EXPLICIT_SELF_HARM.test(normalized)) {
    return immediateResponse({
      text: SELF_HARM_RESPONSE,
      state: baseConversationState(request.state, request.history),
      route: "safety_support",
      reasonCode: "explicit_self_harm_language",
      startedAt,
    });
  }

  const base = baseConversationState(request.state, request.history);
  const floor = hardSafetyFloor(normalized, base.entities);
  if (floor?.response) {
    const resolved = resolveConversationState(
      normalized,
      request.state,
      request.history
    );
    return immediateResponse({
      text: floor.response,
      state: resolved.state,
      route:
        floor.reasonCode === "explicit_self_harm" ? "safety_support" : "refused",
      reasonCode: floor.reasonCode,
      startedAt,
    });
  }

  const triage = await (dependencies.triage ?? triageWithLLM)({
    message: normalized,
    history: request.history,
    state: request.state,
  });
  if (triage) {
    return answerWithTriage(scoped, triage, dependencies, startedAt);
  }
  // LLM lanes exist but all failed: give one honest, retryable, state-preserving
  // reply instead of impersonating the product with regex routing.
  if (hasAnySynthesisLlm && !dependencies.triage) {
    return answerDegraded(scoped, startedAt);
  }
  // No LLM configured at all (offline dev/tests): deterministic brain is the
  // only brain, so use it fully.
  return answerWithHeuristics(scoped, dependencies, startedAt);
}

export type { ChatDependencies } from "./chat-shared";
export type {
  ChatReply,
  ChatRequest,
  ChatTurn,
} from "./types";

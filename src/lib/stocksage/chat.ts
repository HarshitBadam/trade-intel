import "server-only";

import { baseConversationState } from "./entities";
import { EXPLICIT_SELF_HARM, normalizeMessage } from "./intent";
import { answerWithHeuristics } from "./chat-heuristics";
import { answerWithTriage } from "./chat-triage";
import {
  immediateResponse,
  SELF_HARM_RESPONSE,
  type ChatDependencies,
} from "./chat-shared";
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

  const triage = await (dependencies.triage ?? triageWithLLM)({
    message: normalized,
    history: request.history,
    state: request.state,
  });
  if (triage) {
    return answerWithTriage(scoped, triage, dependencies, startedAt);
  }
  return answerWithHeuristics(scoped, dependencies, startedAt);
}

export type { ChatDependencies } from "./chat-shared";
export type {
  ChatReply,
  ChatRequest,
  ChatTurn,
} from "./types";

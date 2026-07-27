import "server-only";

import { hasAnySynthesisLlm } from "@/lib/config";
import {
  baseConversationState,
  resolveConversationState,
} from "./entities";
import {
  EXPLICIT_SELF_HARM,
  immediateReply,
  normalizeMessage,
  routeMessage,
} from "./intent";
import { answerWithHeuristics } from "./chat-heuristics";
import { answerWithModel } from "./chat-model";
import {
  immediateResponse,
  SELF_HARM_RESPONSE,
  type ChatDependencies,
} from "./chat-shared";
import {
  classifyHighStakes,
  evaluateDomainPolicy,
  hardSafetyFloor,
  pickHighStakesReply,
} from "./policy";
import { creativeRequestOnly } from "./regular-guards";
import {
  ABUSE_AT_BOT,
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
  FRUSTRATION,
  HELP,
  SOCIAL,
} from "./social-patterns";
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
  // Resolve entities before policy so safety checks see newly named subjects.
  const initialResolution = resolveConversationState(
    normalized,
    request.state,
    request.history
  );
  const policyEntities =
    initialResolution.entities.length > 0
      ? initialResolution.entities
      : initialResolution.state.entities.length > 0
        ? initialResolution.state.entities
        : base.entities;
  const floor = hardSafetyFloor(normalized, policyEntities);
  if (floor?.response) {
    const resolved = initialResolution;
    const highStakes =
      floor.reasonCode === "high_stakes_finance"
        ? classifyHighStakes(normalized, policyEntities)
        : null;
    const picked = highStakes
      ? pickHighStakesReply(
          highStakes,
          resolved.state.safetyRepliesUsed ?? []
        )
      : null;
    const state = picked
      ? {
          ...resolved.state,
          safetyRepliesUsed: [
            ...(resolved.state.safetyRepliesUsed ?? []),
            picked.id,
          ].slice(-24),
        }
      : resolved.state;
    return immediateResponse({
      text: picked?.text ?? floor.response,
      state,
      route:
        floor.reasonCode === "explicit_self_harm" ? "safety_support" : "refused",
      reasonCode: floor.reasonCode,
      startedAt,
    });
  }

  const socialResolution = initialResolution;
  if (creativeRequestOnly(normalized)) {
    const policy = evaluateDomainPolicy(normalized, []);
    return immediateResponse({
      text:
        policy.response ??
        "I stick to financial markets and company research, so I can’t write the creative piece.",
      state: socialResolution.state,
      route: "out_of_scope",
      reasonCode: "out_of_scope",
      startedAt,
    });
  }
  const socialDecision = routeMessage({
    message: normalized,
    entities: socialResolution.entities,
    state: socialResolution.state,
    clarification: socialResolution.clarification,
  });
  const closedSocial =
    SOCIAL.test(normalized) ||
    FAREWELL.test(normalized) ||
    CASUAL_ACKNOWLEDGEMENT.test(normalized) ||
    HELP.test(normalized) ||
    FRUSTRATION.test(normalized) ||
    ABUSE_AT_BOT.test(normalized);
  if (closedSocial && socialDecision.route === "social") {
    const text = immediateReply(socialDecision, normalized);
    if (text) {
      return immediateResponse({
        text,
        state: socialResolution.state,
        route: "social",
        reasonCode: socialDecision.reasonCode,
        startedAt,
      });
    }
  }

  if (hasAnySynthesisLlm) {
    return answerWithModel(scoped, dependencies, startedAt, initialResolution);
  }
  return answerWithHeuristics(scoped, dependencies, startedAt);
}

export type { ChatDependencies } from "./chat-shared";
export type {
  ChatReply,
  ChatRequest,
  ChatTurn,
} from "./types";

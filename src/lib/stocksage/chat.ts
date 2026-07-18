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
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
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
  const floor = hardSafetyFloor(normalized, base.entities);
  if (floor?.response) {
    const resolved = resolveConversationState(
      normalized,
      request.state,
      request.history
    );
    // High-stakes refusals rotate through context-aware variants; the IDs
    // already shown ride in conversation state so a session never sees the
    // same body twice.
    const highStakes =
      floor.reasonCode === "high_stakes_finance"
        ? classifyHighStakes(normalized, base.entities)
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

  // Closed-class social turns are deterministic and need neither retrieval
  // nor synthesis. Resolve state first so a farewell or acknowledgement does
  // not erase finance context needed by a later follow-up.
  const socialResolution = resolveConversationState(
    normalized,
    request.state,
    request.history
  );
  // A creative request remains outside the product lane even when its subject
  // is an inherited or explicitly named stock. This must run before the model
  // path so an outage cannot turn it into market-data boilerplate.
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
    HELP.test(normalized);
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

  // One model call per turn: the model reads the raw conversation, classifies
  // the turn itself, resolves references itself, and answers with prefetched
  // data. Deterministic code above this line handles only hard safety; below,
  // it only decides what data to prefetch.
  if (hasAnySynthesisLlm) {
    return answerWithModel(scoped, dependencies, startedAt);
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

import "server-only";

import { randomUUID } from "node:crypto";
import { createDeepResearchOffer } from "./deep-snapshot";
import { resolveConversationState } from "./entities";
import { immediateReply, routeMessage } from "./intent";
import { planEvidence } from "./planning";
import { evaluateDomainPolicy } from "./policy";
import { answerRegularChat } from "./regular";
import { executeEvidencePlan } from "./retrieve";
import { logStockSage } from "./telemetry";
import {
  immediateResponse,
  type ChatDependencies,
} from "./chat-shared";
import type { ChatReply, ChatRequest } from "./types";

function hasExplicitConversationReference(message: string): boolean {
  return (
    /\b(?:it|its|that|they|their|them|those|these|both|former|latter|what about|how about|wb|which (?:one|is|looks)|all of them)\b/i.test(
      message
    ) ||
    /\b(?:a|the)\s+\w+(?:er)?\s+one(?:s)?\b/i.test(message) ||
    /^(?:(?:and|so|ok(?:ay)?)\s+)?(?:why|what (?:changed|happened|moved)|today|yesterday|(?:a\s+)?few days ago|anything notable|last (?:few days|week|month|quarter|year)|this (?:week|month|quarter|year))\b/i.test(
      message
    ) ||
    /\b(?:which developments?\b.*\bmatters?|what\b.*\bmatters?|catalysts?|what should investors? watch)\b/i.test(
      message
    )
  );
}

const DEGRADED_RESPONSE =
  "Name the company, metric, and time period, and I’ll return only matched dated evidence.";

function outageFloor(
  entities: ReturnType<typeof resolveConversationState>["entities"]
): string {
  if (entities.length === 0 || !entities.every((entity) => entity.private)) {
    return DEGRADED_RESPONSE;
  }
  const names = entities.map((entity) => entity.name);
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names[0];
  return `${list} ${names.length === 1 ? "is" : "are"} privately held, so the relevant lens is business performance, financing, growth, and risk rather than public-share returns. Name the dimension you want analyzed.`;
}

// Deterministic fallback for when every LLM lane is unavailable.
export function answerDegraded(
  request: ChatRequest,
  startedAt: number
): ChatReply {
  const resolution = resolveConversationState(
    request.message,
    request.state,
    request.history
  );
  const decision = routeMessage({
    message: request.message,
    entities: resolution.entities,
    state: resolution.state,
  });
  if (decision.route === "social" || decision.route === "safety_support") {
    const immediate = immediateReply(decision, request.message);
    if (immediate) {
      return immediateResponse({
        text: immediate,
        state: resolution.state,
        route: decision.route,
        reasonCode: decision.reasonCode,
        startedAt,
      });
    }
  }
  const standalone =
    resolution.state.entities.length === 0 &&
    !hasExplicitConversationReference(request.message);
  if (standalone) {
    const policy = evaluateDomainPolicy(request.message, []);
    if (
      policy.action === "respond" &&
      policy.response &&
      policy.reasonCode === "out_of_scope"
    ) {
      return immediateResponse({
        text: policy.response,
        state: resolution.state,
        route: "out_of_scope",
        reasonCode: policy.reasonCode,
        startedAt,
      });
    }
  }
  return immediateResponse({
    text: outageFloor(
      resolution.entities.length > 0
        ? resolution.entities
        : resolution.state.entities
    ),
    state: resolution.state,
    route: "general",
    reasonCode: "all_llm_lanes_unavailable",
    startedAt,
    retryable: true,
    dataStatus: "unavailable",
  });
}

export async function answerWithHeuristics(
  request: ChatRequest,
  dependencies: ChatDependencies,
  startedAt: number
): Promise<ChatReply> {
  const resolution = resolveConversationState(
    request.message,
    request.state,
    request.history
  );
  if (resolution.clarification) {
    return immediateResponse({
      text: resolution.clarification,
      state: resolution.state,
      route: "clarify",
      reasonCode: resolution.reasonCode,
      startedAt,
    });
  }
  const conversationReference = hasExplicitConversationReference(
    request.message
  );
  const effectiveEntities =
    resolution.entities.length > 0
      ? resolution.entities
      : conversationReference
        ? resolution.state.entities
        : [];
  const policyEntities =
    resolution.reasonCode === "no_entities" && !conversationReference
      ? []
      : effectiveEntities;
  const policy = evaluateDomainPolicy(request.message, policyEntities);
  const inheritsScope =
    policy.reasonCode === "out_of_scope" &&
    request.history.length > 0 &&
    hasExplicitConversationReference(request.message);
  if (policy.action !== "allow" && !inheritsScope) {
    return immediateResponse({
      text: policy.response ?? "Please ask a financial-market question.",
      state: resolution.state,
      route:
        policy.action === "clarify"
          ? "clarify"
          : policy.reasonCode === "out_of_scope"
            ? "out_of_scope"
            : "refused",
      reasonCode: policy.reasonCode,
      startedAt,
    });
  }
  const decision = routeMessage({
    message: request.message,
    entities: effectiveEntities,
    state: resolution.state,
    clarification: resolution.clarification,
  });
  const immediate = immediateReply(decision, request.message);
  if (immediate) {
    return immediateResponse({
      text: immediate,
      state: resolution.state,
      route: decision.route,
      reasonCode: decision.reasonCode,
      startedAt,
    });
  }
  const plan = planEvidence({
    route: decision.route,
    message: request.message,
    entities: effectiveEntities,
    state: resolution.state,
  });
  const retrievalStartedAt = Date.now();
  const context = await executeEvidencePlan({
    plan,
    entities: effectiveEntities,
    providers: dependencies.retrievalProviders,
  });
  const retrievalMs = Date.now() - retrievalStartedAt;
  const synthesisStartedAt = Date.now();
  const reply = await answerRegularChat(
    request,
    decision,
    effectiveEntities,
    resolution.state,
    context
  );
  const synthesisMs = Date.now() - synthesisStartedAt;
  const deepEligible = decision.deepEligible;
  const deep = deepEligible
    ? createDeepResearchOffer({
        question: request.message,
        reply,
        entities: effectiveEntities,
        state: resolution.state,
        sources: context.sources,
        asOf: plan.asOf,
      })
    : { responseId: randomUUID() };
  logStockSage({
    event: "request_complete",
    route: decision.route,
    reasonCode: decision.reasonCode,
    durationMs: Date.now() - startedAt,
    retrievalMs,
    synthesisMs,
    providerCount: plan.queries.length,
    sourceCount: context.sources.length,
  });
  return {
    ...reply,
    kind: "answer",
    responseId: deep.responseId,
    deepResearch: deep.offer,
    state: resolution.state,
  };
}

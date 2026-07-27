import "server-only";

import { randomUUID } from "node:crypto";
import { budgetFor } from "./budget";
import { createDeepResearchOffer } from "./deep-snapshot";
import { resolveConversationState } from "./entities";
import { immediateReply, routeMessage } from "./intent";
import { planEvidence } from "./planning";
import { evaluateDomainPolicy } from "./policy";
import { answerRegularChat } from "./regular";
import { executeEvidencePlan, type RegularContext } from "./retrieve";
import { createPhaseTimer, logStockSage } from "./telemetry";
import { turnFromRoute as legacyTurn } from "./turn-decision";
import {
  immediateResponse,
  type ChatDependencies,
  type ExecutorOptions,
} from "./chat-shared";
import type {
  ChatReply,
  ChatRequest,
  ConversationState,
  EvidencePlan,
  FinanceEntity,
  Turn,
} from "./types";

function emptyRegularContext(plan: EvidencePlan): RegularContext {
  return {
    quotes: [],
    fundamentals: [],
    sources: [],
    coverage: {},
    plan: { ...plan, queries: [] },
  };
}

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

/**
 * Deterministic fallback for when every LLM lane is unavailable, or when the
 * budget expired before one answered. It renders the frozen decision; it only
 * classifies for itself when called without one, which is the reversible
 * `STOCKSAGE_TURN_DECISION=off` path.
 */
export function answerDegraded(
  request: ChatRequest,
  startedAt: number,
  turn?: Turn
): ChatReply {
  const resolution = turn
    ? { state: turn.context.state, entities: turn.context.entities }
    : resolveConversationState(request.message, request.state, request.history);
  if (turn) {
    if (turn.decision.immediateText) {
      return immediateResponse({
        text: turn.decision.immediateText,
        state: resolution.state,
        route: turn.decision.route,
        reasonCode: turn.decision.reasonCode,
        startedAt,
        decision: turn.decision,
      });
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
  return legacyDegraded(request, startedAt, resolution);
}

function legacyDegraded(
  request: ChatRequest,
  startedAt: number,
  resolution: { state: ConversationState; entities: FinanceEntity[] }
): ChatReply {
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

/**
 * Falls back to self-classification only when no frozen decision was supplied,
 * which is the reversible `STOCKSAGE_TURN_DECISION=off` path.
 */
function legacyClassification(request: ChatRequest): Turn | ChatReplyShortCircuit {
  const resolution = resolveConversationState(
    request.message,
    request.state,
    request.history
  );
  if (resolution.clarification) {
    return {
      shortCircuit: true,
      text: resolution.clarification,
      state: resolution.state,
      route: "clarify",
      reasonCode: resolution.reasonCode,
    };
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
    conversationReference;
  if (policy.action !== "allow" && !inheritsScope) {
    return {
      shortCircuit: true,
      text: policy.response ?? "Please ask a financial-market question.",
      state: resolution.state,
      route:
        policy.action === "clarify"
          ? "clarify"
          : policy.reasonCode === "out_of_scope"
            ? "out_of_scope"
            : "refused",
      reasonCode: policy.reasonCode,
    };
  }
  const route = routeMessage({
    message: request.message,
    entities: effectiveEntities,
    state: resolution.state,
    clarification: resolution.clarification,
  });
  const immediate = immediateReply(route, request.message);
  if (immediate) {
    return {
      shortCircuit: true,
      text: immediate,
      state: resolution.state,
      route: route.route,
      reasonCode: route.reasonCode,
    };
  }
  return legacyTurn({
    message: request.message,
    route,
    entities: effectiveEntities,
    state: resolution.state,
  });
}

type ChatReplyShortCircuit = {
  shortCircuit: true;
  text: string;
  state: ConversationState;
  route: string;
  reasonCode: string;
};

export async function answerWithHeuristics(
  request: ChatRequest,
  dependencies: ChatDependencies,
  startedAt: number,
  options: ExecutorOptions = {}
): Promise<ChatReply> {
  let turn = options.turn;
  if (!turn) {
    const classified = legacyClassification(request);
    if ("shortCircuit" in classified) {
      return immediateResponse({
        text: classified.text,
        state: classified.state,
        route: classified.route,
        reasonCode: classified.reasonCode,
        startedAt,
      });
    }
    turn = classified;
  }
  const { decision, context } = turn;
  const entities = context.entities;
  const budget = options.budget ?? budgetFor("regular", startedAt);
  const timer = createPhaseTimer();

  const endPlanning = timer.start("planning");
  const plan = planEvidence({
    route: decision.route,
    message: request.message,
    entities,
    state: context.state,
    intervals: context.intervals,
    retrievalAuthorized: decision.retrievalAuthorized,
  });
  endPlanning();
  timer.provider("plan_queries", plan.queries.length);

  const endRetrieval = timer.start("retrieval");
  const context_ = decision.retrievalAuthorized
    ? await executeEvidencePlan({
        plan,
        entities,
        providers: dependencies.retrievalProviders,
        budget,
      })
    : emptyRegularContext(plan);
  endRetrieval();

  const endSynthesis = timer.start("synthesis");
  const reply = await answerRegularChat(
    request,
    {
      route: decision.route,
      reasonCode: decision.reasonCode,
      retrievalRequired: decision.retrievalAuthorized,
      deepEligible: decision.deepEligible,
      ...(decision.clarification
        ? { clarification: decision.clarification }
        : {}),
    },
    entities,
    context.state,
    context_,
    { budget }
  );
  endSynthesis();

  const deep = decision.deepEligible
    ? createDeepResearchOffer({
        question: request.message,
        reply,
        entities,
        state: context.state,
        sources: context_.sources,
        asOf: plan.asOf,
      })
    : { responseId: randomUUID() };
  const timings = timer.timings();
  logStockSage({
    event: "request_complete",
    route: decision.route,
    decisionKind: decision.kind,
    routeClass: decision.routeClass,
    latencyClass: decision.latencyClass,
    reasonCode: decision.reasonCode,
    durationMs: Date.now() - startedAt,
    ...timings,
    providerCount: plan.queries.length,
    sourceCount: context_.sources.length,
    budgetMs: budget.totalMs,
    remainingMs: budget.remainingMs(),
    budgetExceeded: budget.expired(),
    deepEligible: decision.deepEligible,
    retryVisible: reply.retryable === true,
  });
  return {
    ...reply,
    kind: "answer",
    responseId: deep.responseId,
    deepResearch: deep.offer,
    state: context.state,
  };
}

import "server-only";

import { randomUUID } from "node:crypto";
import { createDeepResearchOffer } from "./deep-snapshot";
import {
  baseConversationState,
  resolveConversationState,
  resolveEntityHints,
} from "./entities";
import { detectJurisdiction } from "./conversation-attributes";
import { immediateReply } from "./intent";
import { planEvidence } from "./planning";
import { unsupportedFigures } from "./figures";
import { evaluateDomainPolicy, OUT_OF_SCOPE_RESPONSE } from "./policy";
import { buildChatSystemPrompt, type AnswerKind } from "./regular-prompt";
import { answerRegularChat, historyMessages } from "./regular";
import { executeEvidencePlan } from "./retrieve";
import { synthesizeWithFallback } from "./synthesis";
import { logStockSage } from "./telemetry";
import type { Triage } from "./triage";
import {
  immediateResponse,
  PROHIBITED_FALLBACK,
  SELF_HARM_RESPONSE,
  type ChatDependencies,
} from "./chat-shared";
import type {
  ChatReply,
  ChatRequest,
  ConversationState,
  RouteDecision,
} from "./types";

async function conversationalReply(args: {
  kind: Exclude<AnswerKind, "finance">;
  request: ChatRequest;
  note?: string;
  fallback: string;
}): Promise<string> {
  try {
    const figureCorpus = [
      ...args.request.history
        .filter((turn) => turn.role === "user")
        .map((turn) => turn.text),
      args.request.message,
    ].join("\n");
    const text = await synthesizeWithFallback({
      system: buildChatSystemPrompt({ kind: args.kind, note: args.note }),
      history: historyMessages(args.request),
      user: args.request.message,
      maxTokens: args.kind === "social" ? 150 : 170,
      temperature: args.kind === "social" ? 0.7 : 0.5,
      timeoutMs: 8_000,
      totalTimeoutMs: 12_000,
      event: "social_synthesis",
      lane: "light",
      accept: (candidate) =>
        unsupportedFigures(candidate, figureCorpus).length === 0 &&
        !/\b(?:according to (?:some |recent )?(?:reports?|news|sources)|news shows|reports? (?:say|show|suggest))\b/i.test(
          candidate
        ),
      correction:
        "Rewrite that reply without quoting any prices, percentages, dollar figures, or claims attributed to news and reports — you don't have market data in front of you for this turn.",
    });
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  } catch {
  }
  return args.fallback;
}

function mapCriteria(criteria: string[]): string[] {
  const known = new Set([
    "performance",
    "valuation",
    "earnings",
    "growth",
    "risk",
    "dividends",
    "outlook",
    "size",
  ]);
  return [...new Set(criteria.filter((criterion) => known.has(criterion)))];
}

export async function answerWithTriage(
  request: ChatRequest,
  triage: Triage,
  dependencies: ChatDependencies,
  startedAt: number
): Promise<ChatReply> {
  const base = baseConversationState(request.state, request.history);

  if (triage.category === "self_harm") {
    return immediateResponse({
      text: SELF_HARM_RESPONSE,
      state: base,
      route: "safety_support",
      reasonCode: "llm_triage_self_harm",
      startedAt,
    });
  }

  const floor = evaluateDomainPolicy(request.message, base.entities);
  const hardProhibited =
    floor.action === "respond" && /^prohibited_/.test(floor.reasonCode);
  const category = hardProhibited ? "prohibited" : triage.category;

  if (
    category === "social" ||
    category === "off_topic" ||
    category === "prohibited"
  ) {
    const fallback =
      category === "social"
        ? immediateReply(
            {
              route: "social",
              reasonCode: "social",
              retrievalRequired: false,
              deepEligible: false,
            },
            request.message
          ) ?? "Hey! What are you looking into?"
        : category === "off_topic"
          ? OUT_OF_SCOPE_RESPONSE
          : floor.response ?? PROHIBITED_FALLBACK;
    const note =
      category === "prohibited"
        ? [
            triage.prohibitedKind && `request type: ${triage.prohibitedKind}`,
            triage.note,
          ]
            .filter(Boolean)
            .join("; ") || undefined
        : triage.note;
    const text = await conversationalReply({
      kind: category,
      request,
      note,
      fallback,
    });
    return immediateResponse({
      text,
      state: base,
      route: category,
      reasonCode: hardProhibited ? floor.reasonCode : `llm_triage_${category}`,
      startedAt,
    });
  }

  const heuristic = resolveConversationState(
    request.message,
    request.state,
    request.history
  );
  const deterministicWins = new Set([
    "ordered_reference_resolved",
    "anchored_reference_resolved",
    "entity_correction",
    "canonical_group_expanded",
  ]);
  const useHeuristic =
    deterministicWins.has(heuristic.reasonCode) &&
    heuristic.entities.length > 0;
  const resolved = useHeuristic
    ? heuristic.entities
    : resolveEntityHints(triage.subjects, base.entities);
  if (resolved.length === 0 && heuristic.clarification) {
    return immediateResponse({
      text: heuristic.clarification,
      state: base,
      route: "clarify",
      reasonCode: heuristic.reasonCode,
      startedAt,
    });
  }
  const explicit = resolved.length > 0 ? resolved : heuristic.entities;
  const entities = explicit.length > 0 ? explicit : base.entities;
  const criteria = mapCriteria(triage.criteria);
  const comparative =
    (triage.comparison || explicit.length >= 2) && entities.length >= 2;
  const ranking = entities.some((entity) =>
    /^Fortune (?:100|500)$/.test(entity.name)
  );
  const needsCurrentData = triage.needsCurrentData || comparative || ranking;
  const route: RouteDecision["route"] = needsCurrentData
    ? comparative
      ? "comparison"
      : "current_finance"
    : "stable_finance";
  const nextState: ConversationState = useHeuristic
    ? {
        ...heuristic.state,
        criteria: criteria.length > 0 ? criteria : heuristic.state.criteria,
        horizon: triage.timeframe ?? heuristic.state.horizon,
      }
    : {
        version: 1,
        revision: base.revision + 1,
        entities: entities.length > 0 ? entities : base.entities,
        explicitEntitySet:
          explicit.length > 0
            ? explicit.map((entity) => entity.id)
            : base.explicitEntitySet,
        criteria: criteria.length > 0 ? criteria : base.criteria,
        horizon: triage.timeframe ?? base.horizon,
        jurisdiction:
          detectJurisdiction(request.message, entities) ?? base.jurisdiction,
      };
  const planMessage =
    triage.timeframe &&
    !request.message.toLowerCase().includes(triage.timeframe)
      ? `${request.message} (${triage.timeframe})`
      : request.message;
  const plan = planEvidence({
    route,
    message: planMessage,
    entities,
    state: nextState,
  });
  const retrievalStartedAt = Date.now();
  const context = await executeEvidencePlan({
    plan,
    entities,
    providers: dependencies.retrievalProviders,
  });
  const retrievalMs = Date.now() - retrievalStartedAt;
  const decision: RouteDecision = {
    route,
    reasonCode: "llm_triage",
    retrievalRequired: plan.queries.length > 0,
    deepEligible: needsCurrentData,
  };
  const note = useHeuristic
    ? `the user's reference resolves to exactly: ${explicit
        .map((entity) => entity.name)
        .join(", ")}`
    : triage.note;
  const synthesisStartedAt = Date.now();
  const reply = await answerRegularChat(
    request,
    decision,
    entities,
    nextState,
    context,
    {
      timeframe: triage.timeframe,
      criteria,
      note,
    }
  );
  const synthesisMs = Date.now() - synthesisStartedAt;
  const deep =
    decision.deepEligible && reply.live
      ? createDeepResearchOffer({
          question: request.message,
          reply,
          entities,
          state: nextState,
          sources: context.sources,
          asOf: plan.asOf,
        })
      : { responseId: randomUUID() };
  logStockSage({
    event: "request_complete",
    route,
    reasonCode: "llm_triage",
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
    state: nextState,
  };
}

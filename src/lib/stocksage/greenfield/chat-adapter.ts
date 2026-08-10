import "server-only";

import { randomUUID } from "node:crypto";
import { budgetFor } from "../budget";
import { safeSourceUrl } from "../citations";
import type { ChatDependencies } from "../chat-shared";
import {
  createDeepResearchOffer,
  type DeepResearchObligationScope,
  type DeepResearchScope,
  type DeepResearchSourceRef,
} from "../deep/snapshot";
import { logStockSage, type RouteClass } from "../telemetry";
import type {
  ChatDataStatus,
  ChatPresentationMode,
  ChatReply,
  ChatRequest,
  ChatRoute,
  ClarificationChoice,
  FinanceEntity,
} from "../types";
import type { AnswerObligationKind } from "./answer-obligations";
import {
  runGreenfieldTurn,
  type GreenfieldReply,
} from "./engine";
import {
  conversationStateFromLedger,
  ledgerFromConversationState,
} from "./live-state";
import type { ResearchEvidence } from "./research";
import {
  groqSemanticJsonModel,
  type SemanticJsonModel,
} from "./semantic-interpreter";

function forceRegularDepth(model: SemanticJsonModel): SemanticJsonModel {
  return async (request) => {
    const raw = await model(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const answer = (raw as { answer?: unknown }).answer;
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      return raw;
    }
    const depth = (answer as { depth?: unknown }).depth;
    if (depth !== "deep") return raw;
    return {
      ...raw,
      answer: { ...answer, depth: "standard" },
    };
  };
}

function publishedEvidence(reply: GreenfieldReply): ResearchEvidence[] {
  const evidence = reply.sections
    ? reply.sections
        .filter((section) => Boolean(section.text?.trim()))
        .flatMap((section) => section.evidence)
    : reply.trace.evidence;
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

function safeCitationUrls(evidence: readonly ResearchEvidence[]): string[] {
  const urls = evidence.flatMap((item) => {
    const url = item.sourceUrl ? safeSourceUrl(item.sourceUrl) : null;
    return url ? [url] : [];
  });
  return [...new Set(urls)].slice(0, 16);
}

function dataStatusFor(reply: GreenfieldReply): ChatDataStatus {
  if (reply.kind === "unavailable") return "unavailable";
  if (!reply.sections || reply.sections.length === 0) return "full";
  const published = reply.sections.filter((section) => Boolean(section.text?.trim()));
  if (published.length === 0) return "unavailable";
  return reply.sections.every((section) => section.status === "complete")
    ? "full"
    : "limited";
}

function routeFor(reply: GreenfieldReply): ChatRoute {
  if (reply.kind === "clarification") return "clarify";
  if (reply.kind === "safety_support") return "safety_support";
  if (reply.kind === "refused") {
    return reply.trace.interpretation?.semantic.intent.kind === "out_of_scope"
      ? "out_of_scope"
      : "refused";
  }
  const intent = reply.trace.interpretation?.semantic.intent.kind;
  if (intent === "social" || intent === "capability") return "social";
  const plan = reply.trace.plan;
  if (!plan) return "general";
  if (plan.comparison || plan.entities.length > 1) return "comparison";
  const stableOnly =
    plan.obligations.length > 0 &&
    plan.obligations.every((obligation) => obligation.kind === "define");
  return stableOnly ? "stable_finance" : "current_finance";
}

function presentationModeForReply(
  reply: GreenfieldReply,
  route: ChatRoute,
  dataStatus: ChatDataStatus
): ChatPresentationMode | undefined {
  if (reply.kind === "clarification") return "clarification";
  if (reply.kind === "refused" || reply.kind === "safety_support") return undefined;
  if (route === "social") return "social";
  if (!reply.trace.plan) return undefined;
  if (dataStatus === "unavailable") return "no_evidence";
  if (dataStatus === "limited") return "limited_evidence";
  if (route === "comparison") return "comparison";
  if (route === "current_finance") return "current_finance";
  if (route === "stable_finance") return "stable_finance";
  return undefined;
}

function presentationReasonFor(
  reply: GreenfieldReply,
  dataStatus: ChatDataStatus
): string {
  if (reply.kind === "clarification") return "greenfield_material_ambiguity";
  if (dataStatus === "unavailable") return "greenfield_no_publishable_section";
  if (dataStatus === "limited") return "greenfield_partial_sections";
  return "greenfield_complete";
}

function clarificationChoices(reply: GreenfieldReply): ClarificationChoice[] | undefined {
  if (reply.kind !== "clarification") return undefined;
  for (const ambiguity of reply.trace.interpretation?.semantic.ambiguities ?? []) {
    if (!ambiguity.requiresClarification) continue;
    const labels = [
      ...new Set(
        ambiguity.candidates.map((candidate) => candidate.trim()).filter(Boolean)
      ),
    ].slice(0, 4);
    const canonicalBigFourFork =
      labels.length >= 2 &&
      labels.every((label) => /\bbig\s*(?:4|four)\b/i.test(label)) &&
      labels.some((label) => /\bbanks?\b/i.test(label)) &&
      labels.some((label) =>
        /\b(?:consult|professional|account|audit)/i.test(label)
      );
    if (!canonicalBigFourFork) continue;
    return labels.map((label, index) => ({
      id: `${ambiguity.id}:${index + 1}`.slice(0, 120),
      label,
    }));
  }
  return undefined;
}

const CRITERIA_BY_OBLIGATION: Partial<
  Record<AnswerObligationKind, readonly string[]>
> = {
  snapshot: ["performance"],
  compare: ["performance"],
  explain_cause: ["performance", "outlook"],
  assess_outlook: ["outlook", "risk"],
  verify_source: ["outlook"],
};

function obligationQuery(fallback: string): string {
  return fallback.trim().slice(0, 400);
}

function researchScopeFor(reply: GreenfieldReply): DeepResearchScope | undefined {
  const plan = reply.trace.plan;
  if (!plan) return undefined;
  const canonicalIds = new Set(plan.entities.map((entity) => entity.id));
  const obligations: DeepResearchObligationScope[] = plan.obligations
    .filter((obligation) => obligation.publicationRole === "narrative")
    .flatMap((obligation) => {
      const entityIds = [
        ...new Set(
          obligation.entities
            .map((entity) => entity.id)
            .filter((id) => canonicalIds.has(id))
        ),
      ].slice(0, 12);
      if (entityIds.length === 0) return [];
      const queries = [
        ...new Set(
          obligation.needs.flatMap((need) =>
            need.kind === "documents" && need.query.trim() ? [need.query.trim()] : []
          )
        ),
      ];
      const query = obligationQuery(queries.join("; ") || plan.standaloneQuery);
      if (!query) return [];
      return [
        {
          id: obligation.id.slice(0, 80),
          kind: obligation.kind,
          query,
          entityIds,
          intervals: obligation.intervals.slice(0, 8),
        },
      ];
    })
    .slice(0, 4);
  return obligations.length > 0 ? { version: 1, obligations } : undefined;
}

function selectedEntities(
  reply: GreenfieldReply,
  scope: DeepResearchScope
): FinanceEntity[] {
  const wanted = new Set(
    scope.obligations.flatMap((obligation) => obligation.entityIds)
  );
  return (reply.trace.plan?.entities ?? []).filter((entity) => wanted.has(entity.id));
}

function narrativeEvidence(reply: GreenfieldReply): ResearchEvidence[] {
  const narrativeIds = new Set(
    reply.trace.plan?.obligations
      .filter((obligation) => obligation.publicationRole === "narrative")
      .map((obligation) => obligation.id) ?? []
  );
  return [
    ...new Map(
      (reply.sections ?? [])
        .filter((section) => narrativeIds.has(section.obligationId))
        .flatMap((section) => section.evidence)
        .map((item) => [item.id, item])
    ).values(),
  ];
}

function deepSources(
  reply: GreenfieldReply,
  scope: DeepResearchScope
): DeepResearchSourceRef[] {
  const canonicalIds = new Set(
    scope.obligations.flatMap((obligation) => obligation.entityIds)
  );
  const criteriaByEntity = new Map<string, Set<string>>();
  for (const obligation of scope.obligations) {
    for (const entityId of obligation.entityIds) {
      const criteria = criteriaByEntity.get(entityId) ?? new Set<string>();
      for (const criterion of CRITERIA_BY_OBLIGATION[obligation.kind] ?? []) {
        criteria.add(criterion);
      }
      criteriaByEntity.set(entityId, criteria);
    }
  }
  const byUrl = new Map<string, DeepResearchSourceRef>();
  for (const item of narrativeEvidence(reply)) {
    const url = item.sourceUrl ? safeSourceUrl(item.sourceUrl) : null;
    if (!url || byUrl.has(url)) continue;
    const entityIds = [
      ...new Set([...(item.subjectIds ?? []), ...(item.subjectId ? [item.subjectId] : [])]),
    ].filter((id) => canonicalIds.has(id));
    const criteria = [
      ...new Set(entityIds.flatMap((id) => [...(criteriaByEntity.get(id) ?? [])])),
    ];
    byUrl.set(url, {
      id: `S${byUrl.size + 1}`,
      url,
      entityIds,
      criteria,
    });
  }
  return [...byUrl.values()].slice(0, 16);
}

function providerCalls(evidence: readonly ResearchEvidence[]): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const item of evidence) calls[item.sourceId] = (calls[item.sourceId] ?? 0) + 1;
  return calls;
}

function routeClassFor(reply: GreenfieldReply, route: ChatRoute): RouteClass {
  if (reply.kind === "safety_support") return "instant_safety";
  if (reply.kind === "refused") return "instant_refusal";
  if (reply.kind === "clarification") return "instant_clarify";
  if (route === "social") return "instant_social";
  return "retrieval";
}

/** Maps one regular greenfield turn onto the stable public chat contract. */
export async function runGreenfieldChatAdapter(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const budget = budgetFor("regular", startedAt);
  const configured = dependencies.greenfield ?? {};
  const initialLedger = ledgerFromConversationState(request.state);
  const semanticModel = forceRegularDepth(
    configured.semanticModel ?? groqSemanticJsonModel
  );
  let reply: GreenfieldReply;
  try {
    reply = await runGreenfieldTurn(
      {
        message: request.message,
        sessionId: request.sessionId,
        ledger: initialLedger,
      },
      {
        ...configured,
        semanticModel,
        safetyClassifier:
          dependencies.safetyClassifier ?? configured.safetyClassifier,
        requestBudget: budget,
      }
    );
  } catch (error) {
    logStockSage({
      event: "request_complete",
      route: "greenfield_failure",
      routeClass: "retrieval",
      latencyClass: "regular",
      durationMs: Date.now() - startedAt,
      budgetMs: budget.totalMs,
      remainingMs: budget.remainingMs(),
      budgetExceeded: budget.expired(),
      deadlineHit: budget.expired(),
      publicationFailure: true,
      detail: JSON.stringify({
        engine: "greenfield",
        error: error instanceof Error ? error.name : "unknown",
      }),
    });
    return {
      text: "I couldn’t complete that request within the current service budget. Please retry or narrow the question.",
      live: false,
      kind: "answer",
      retryable: true,
      responseId: randomUUID(),
      state: conversationStateFromLedger(initialLedger, request.state),
      dataStatus: "unavailable",
      presentationMode: "no_evidence",
      presentationReason: "greenfield_contained_failure",
    };
  }

  dependencies.onGreenfieldReply?.(reply);
  const state = conversationStateFromLedger(reply.ledger, request.state);
  const evidence = publishedEvidence(reply);
  const citationUrls = safeCitationUrls(evidence);
  const dataStatus = dataStatusFor(reply);
  const route = routeFor(reply);
  const live =
    evidence.length > 0 &&
    (route === "current_finance" || route === "comparison");
  const presentationMode = presentationModeForReply(reply, route, dataStatus);
  const choices = clarificationChoices(reply);
  const scope = researchScopeFor(reply);
  const deep =
    scope && (reply.kind === "answer" || reply.kind === "unavailable")
      ? createDeepResearchOffer({
          question: request.message,
          reply: {
            text: reply.text,
            live,
            citationUrls,
            state,
            dataStatus,
          },
          entities: selectedEntities(reply, scope),
          state,
          sources: deepSources(reply, scope),
          asOf: reply.trace.plan?.asOf ?? new Date().toISOString(),
          eligible: true,
          researchScope: scope,
          queueReady: dependencies.deepQueueReady,
        })
      : { responseId: randomUUID() };
  const failures = reply.trace.failures;
  const deadlineHit =
    budget.expired() ||
    failures.some((failure) => /budget expired|deadline/i.test(failure.error));
  const calls = providerCalls(reply.trace.evidence);
  logStockSage({
    event: "request_complete",
    route,
    routeClass: routeClassFor(reply, route),
    latencyClass: "regular",
    reasonCode: presentationReasonFor(reply, dataStatus),
    durationMs: Date.now() - startedAt,
    providerCalls: calls,
    providerCount: Object.values(calls).reduce((sum, count) => sum + count, 0),
    sourceCount: evidence.length,
    dataStatus,
    entities: reply.trace.plan?.entities.map((entity) => entity.id) ?? [],
    budgetMs: budget.totalMs,
    remainingMs: budget.remainingMs(),
    budgetExceeded: budget.expired(),
    deadlineHit,
    publicationFailure: reply.kind === "unavailable",
    retryVisible: reply.kind === "unavailable",
    deepEligible: Boolean(scope),
    detail: JSON.stringify({
      engine: "greenfield",
      forcedExecutionDepth: "regular",
      completeSections:
        reply.sections?.filter((section) => section.status === "complete").length ?? 0,
      partialSections:
        reply.sections?.filter((section) => section.status === "partial").length ?? 0,
      unavailableSections:
        reply.sections?.filter((section) => section.status === "unavailable").length ??
        0,
      failureCount: failures.length,
    }),
  });

  return {
    text: reply.text,
    live,
    kind: "answer",
    ...(reply.kind === "unavailable" ? { retryable: true } : {}),
    ...(citationUrls.length > 0 ? { citationUrls } : {}),
    responseId: deep.responseId,
    ...(deep.offer ? { deepResearch: deep.offer } : {}),
    state,
    dataStatus,
    ...(presentationMode
      ? {
          presentationMode,
          presentationReason: presentationReasonFor(reply, dataStatus),
        }
      : {}),
    ...(choices ? { clarificationChoices: choices } : {}),
  };
}

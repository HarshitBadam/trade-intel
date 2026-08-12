import { randomUUID } from "node:crypto";
import { llmErrorSummary } from "@/lib/llm";
import {
  createEvidenceSources,
  expandValidCitations,
  validCitationUrls,
} from "../citations";
import { resolveConversationState } from "../conversation-entity-state";
import {
  evaluateDomainPolicy,
  hardSafetyFloor,
  OUT_OF_SCOPE_RESPONSE,
} from "../policy";
import type { ChatReply, ChatRequest } from "../types";
import {
  buildSimpleCompositionPayload,
  composeAnswer,
  polishSimpleAnswerStyle,
} from "./composition";
import type {
  RefinedRankingRequest,
  SimpleComposeArgs,
  SimpleEvidencePlan,
  SimpleRuntimeDependencies,
} from "./contracts";
import { extractEvidencePlan } from "./extraction";
import { repairListingRelativePrices } from "./listing-repair";
import { retrieveMarket } from "./market";
import { retrieveFocusedNews, retrieveNews } from "./news";
import {
  rankingRequestsFromSeed,
  refineRankingRequests,
  retrieveRankingCapabilityOutcomes,
} from "./ranking";
import {
  dedupeResolvedIssuerPairs,
  mergeResolvedEntities,
  resolvePairs,
} from "./resolution";
import {
  isColloquialGreeting,
  simpleLlmErrorReply,
} from "./responses";
import { hasSimpleEvidenceRequest } from "./validation";

export async function runSimpleChatAdapter(
  request: ChatRequest,
  dependencies: SimpleRuntimeDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const initial = resolveConversationState(
    request.message,
    request.state,
    request.history
  );
  const floor = hardSafetyFloor(request.message, initial.state.entities);
  if (floor?.response) {
    return {
      text: polishSimpleAnswerStyle(floor.response),
      live: false,
      kind: "answer",
      responseId: randomUUID(),
      state: initial.state,
      dataStatus: "full",
      presentationReason: floor.reasonCode,
    };
  }
  const policy = evaluateDomainPolicy(request.message, initial.state.entities);
  if (
    policy.reasonCode === "social" ||
    (policy.reasonCode === "out_of_scope" &&
      isColloquialGreeting(request.message))
  ) {
    return {
      text: "Hey, good to see you. What company or market should we look at?",
      live: false,
      kind: "answer",
      responseId: randomUUID(),
      state: initial.state,
      dataStatus: "full",
      presentationMode: "social",
      presentationReason: "social",
    };
  }

  let plan: SimpleEvidencePlan;
  try {
    plan = dependencies.extractPlan
      ? await dependencies.extractPlan(request)
      : await extractEvidencePlan(request, dependencies.now);
    dependencies.onExtractionComplete?.(plan);
  } catch (error) {
    return simpleLlmErrorReply(initial.state, "semantic extraction", error);
  }

  if (!hasSimpleEvidenceRequest(plan)) {
    return {
      text: OUT_OF_SCOPE_RESPONSE,
      live: false,
      kind: "answer",
      responseId: randomUUID(),
      state: initial.state,
      dataStatus: "full",
      presentationReason: "simple_no_finance_subject",
    };
  }
  let rankingRequests: RefinedRankingRequest[] = [];
  try {
    rankingRequests =
      plan.rankings.length === 0
        ? []
        : dependencies.refineRankings
          ? await dependencies.refineRankings(
              request,
              plan.rankings,
              dependencies.now
            )
          : dependencies.extractPlan
            ? rankingRequestsFromSeed(plan.rankings)
            : await refineRankingRequests(
                request,
                plan.rankings,
                dependencies.now
              );
    rankingRequests = rankingRequests.map((rankingRequest) => ({
      ...rankingRequest,
      market:
        rankingRequest.market === "UNSPECIFIED"
          ? "US"
          : rankingRequest.market,
    }));
    dependencies.onRankingRefinement?.(rankingRequests);
  } catch (error) {
    return simpleLlmErrorReply(initial.state, "semantic extraction", error);
  }

  let pairs = plan.prices;
  let resolvedPairs = dedupeResolvedIssuerPairs(
    resolvePairs(pairs, initial.state.entities),
    initial.entities
  );
  let entities = [
    ...new Map(
      resolvedPairs.map((pair) => [pair.entity.id, pair.entity])
    ).values(),
  ];
  let state = mergeResolvedEntities(
    initial.state,
    request.state,
    entities
  );
  const dates = resolvedPairs.map((pair) => pair.date);
  const [initialMarket, news, focusedNews, rankingOutcomes] = await Promise.all([
    dependencies.retrieveMarket
      ? dependencies.retrieveMarket(resolvedPairs)
      : retrieveMarket(resolvedPairs),
    dependencies.retrieveGeneralNews
      ? dependencies.retrieveGeneralNews(request, entities, dates)
      : retrieveNews(request, entities, dates),
    dependencies.retrieveFocusedNews
      ? dependencies.retrieveFocusedNews(plan.news, entities)
      : retrieveFocusedNews(plan.news, entities),
    dependencies.retrieveRankingOutcomes
      ? dependencies.retrieveRankingOutcomes(
          rankingRequests,
          dependencies.now
        )
      : retrieveRankingCapabilityOutcomes(
          rankingRequests,
          dependencies.now
        ),
  ]);
  let market = initialMarket;

  const listingContext = market.flatMap((packet) =>
    packet.reason === "range_before_listing" && packet.listingDate
      ? [
          {
            name: packet.name,
            ticker: packet.ticker,
            listingDate: packet.listingDate,
          },
        ]
      : []
  );
  if (
    listingContext.length > 0 &&
    (dependencies.repairListingPrices || !dependencies.extractPlan)
  ) {
    try {
      const repairedPrices = dependencies.repairListingPrices
        ? await dependencies.repairListingPrices(
            request,
            pairs,
            listingContext,
            dependencies.now
          )
        : await repairListingRelativePrices(
            request,
            pairs,
            listingContext,
            dependencies.now
          );
      const originalSubjects = new Set(
        pairs.map(([subject]) => subject.trim().toLowerCase())
      );
      const repairedSubjects = new Set(
        repairedPrices.map(([subject]) => subject.trim().toLowerCase())
      );
      const keepsSubjects =
        [...originalSubjects].every((subject) =>
          repairedSubjects.has(subject)
        ) &&
        [...repairedSubjects].every((subject) =>
          originalSubjects.has(subject)
        );
      if (
        keepsSubjects &&
        JSON.stringify(repairedPrices) !== JSON.stringify(pairs)
      ) {
        pairs = repairedPrices;
        plan = { ...plan, prices: repairedPrices };
        dependencies.onExtractionComplete?.(plan);
        resolvedPairs = dedupeResolvedIssuerPairs(
          resolvePairs(pairs, initial.state.entities),
          initial.entities
        );
        entities = [
          ...new Map(
            resolvedPairs.map((pair) => [pair.entity.id, pair.entity])
          ).values(),
        ];
        state = mergeResolvedEntities(
          initial.state,
          request.state,
          entities
        );
        market = dependencies.retrieveMarket
          ? await dependencies.retrieveMarket(resolvedPairs)
          : await retrieveMarket(resolvedPairs);
      }
    } catch (error) {
      console.warn(
        "[stocksage]",
        JSON.stringify({
          event: "simple_listing_date_repair_failed",
          ...llmErrorSummary(error),
        })
      );
    }
  }
  const rankings = rankingOutcomes.flatMap((outcome) =>
    outcome.evidence ? [outcome.evidence] : []
  );
  const sources = createEvidenceSources(
    [...focusedNews.evidence, ...news],
    10
  );

  const compositionArgs: SimpleComposeArgs = {
    request,
    pairs,
    entities,
    market,
    sources,
    focusedNews,
    rankings,
    rankingOutcomes,
    now: dependencies.now,
  };
  dependencies.onCompositionPayload?.(
    buildSimpleCompositionPayload(compositionArgs)
  );
  let citedDraft: string;
  try {
    citedDraft = polishSimpleAnswerStyle(
      await (dependencies.composeAnswer ?? composeAnswer)(compositionArgs)
    );
  } catch (error) {
    return simpleLlmErrorReply(state, "answer composition", error);
  }
  const text = expandValidCitations(citedDraft, sources);
  const citationUrls = validCitationUrls(citedDraft, sources);
  const expectedMarket = new Set(
    entities
      .filter((entity) => entity.ticker && !entity.private)
      .map((entity) => entity.id)
  ).size;
  const successfulMarket = market.filter(
    (packet) => packet.lastClose !== undefined
  ).length;
  const needsResearchEvidence = entities.some(
    (entity) => entity.private || !entity.ticker
  );
  const marketComplete =
    expectedMarket === 0 || successfulMarket >= expectedMarket;
  const researchComplete = !needsResearchEvidence || sources.length > 0;
  const focusedNewsComplete =
    focusedNews.outcomes.length === 0 ||
    focusedNews.outcomes.every((outcome) => outcome.status === "ok");
  const rankingComplete =
    rankingRequests.length === 0 ||
    (rankingOutcomes.length === rankingRequests.length &&
      rankingOutcomes.every(
        (outcome) =>
          outcome.status === "available" ||
          outcome.status === "needs_clarification"
      ));
  const successfulRankings = rankingOutcomes.filter(
    (outcome) =>
      outcome.status === "available" &&
      outcome.evidence &&
      outcome.evidence.gainers.length > 0 &&
      outcome.evidence.losers.length > 0
  ).length;
  const hasCapabilityAnswer = rankingOutcomes.some(
    (outcome) =>
      outcome.status === "unsupported" ||
      outcome.status === "needs_clarification"
  );
  const hasAnyEvidence =
    successfulMarket > 0 || sources.length > 0 || successfulRankings > 0;
  const hasAnyAnswerBasis = hasAnyEvidence || hasCapabilityAnswer;
  const dataStatus =
    marketComplete &&
    researchComplete &&
    focusedNewsComplete &&
    rankingComplete &&
    hasAnyAnswerBasis
      ? "full"
      : hasAnyAnswerBasis
        ? "limited"
        : "unavailable";
  const uniqueEntities = new Set(entities.map((entity) => entity.id)).size;
  const retryable =
    focusedNews.outcomes.some(
      (outcome) =>
        outcome.status === "unavailable" &&
        outcome.reason !== "not_configured" &&
        outcome.reason !== "wrong_provider"
    ) ||
    rankingOutcomes.some((outcome) => outcome.reason === "provider_error");
  const presentationMode = rankingOutcomes.some(
    (outcome) => outcome.status === "needs_clarification"
  )
    ? "clarification"
    : rankingOutcomes.some((outcome) => outcome.status === "unsupported") &&
        successfulRankings === 0
      ? "limited_evidence"
      : dataStatus === "unavailable"
        ? "no_evidence"
        : dataStatus === "limited"
          ? "limited_evidence"
          : rankingOutcomes.length > 0 || uniqueEntities > 1
            ? "comparison"
            : "current_finance";

  return {
    text,
    live: hasAnyEvidence,
    kind: "answer",
    responseId: randomUUID(),
    state,
    dataStatus,
    ...(retryable ? { retryable: true } : {}),
    presentationMode,
    presentationReason: `simple_pipeline_${Date.now() - startedAt}ms`,
    ...(citationUrls.length > 0 ? { citationUrls } : {}),
  };
}

import { randomUUID } from "node:crypto";
import { createDeepResearchOffer } from "./deep-snapshot";
import { buildFallbackReply, buildDeterministicRankingReply } from "./regular-fallback";
import { roundFiguresForDisplay } from "./rounding";
import { logStockSage, type StockSageEvent } from "./telemetry";
import type { RegularContext } from "./retrieve";
import type { StateResolution } from "./entities";
import type { ChatReply, ChatRequest } from "./types";
export function deterministicModelAnswer(args: {
  request: ChatRequest;
  prefetchEntities: StateResolution["entities"];
  context: RegularContext;
  resolution: StateResolution;
  live: boolean;
  dataStatus: ChatReply["dataStatus"];
  wantsData: boolean;
  requestedCriteria: string[];
  blendedOffTopic: boolean;
  startedAt: number;
  retrievalMs: number;
  telemetry?: Partial<StockSageEvent>;
}): ChatReply | null {
  const { request, prefetchEntities, context, resolution, live, dataStatus, wantsData, requestedCriteria, blendedOffTopic, startedAt, retrievalMs, telemetry } = args;
  const deterministicRanking = buildDeterministicRankingReply(
    request,
    prefetchEntities,
    context,
    resolution.state.horizon
  );
  if (deterministicRanking) {
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_numeric_ranking",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...deterministicRanking,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
      dataStatus:
        deterministicRanking.retryable === true ? "limited" : dataStatus,
    };
  }
  if (blendedOffTopic && wantsData && context.quotes.length > 0) {
    const fallback = buildFallbackReply(
      request,
      {
        route:
          prefetchEntities.length >= 2 ? "comparison" : "current_finance",
        reasonCode: "deterministic_scope_contained_snapshot",
        retrievalRequired: true,
        deepEligible: false,
      },
      prefetchEntities,
      context
    );
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_scope_contained_snapshot",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
      dataStatus,
    };
  }
  const asxProxySnapshot =
    prefetchEntities.length === 1 &&
    context.quotes.length === 1 &&
    context.quotes[0].ticker === "AXJO" &&
    context.quotes[0].proxySymbol === "EWA" &&
    /\b(?:today|latest session|doing|doin|done)\b/i.test(request.message);
  if (asxProxySnapshot) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "current_finance",
        reasonCode: "deterministic_proxy_snapshot",
        retrievalRequired: true,
        deepEligible: false,
      },
      prefetchEntities,
      context
    );
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_proxy_snapshot",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
      dataStatus,
    };
  }
  const newsOrResearchSeeking =
    /\b(?:news|headlines?|developments?|catalysts?|cited|articles?|announce\w*|guidance|outlook|bull case|bear case|risks?)\b/i.test(
      request.message
    );
  const deterministicMarketSnapshot =
    prefetchEntities.length === 1 &&
    context.quotes.length > 0 &&
    !newsOrResearchSeeking &&
    /\b(?:what(?:'?s| is) up|how\b.{0,50}\b(?:doing|doin|done|performing|closed?)|price|trading at|latest|today|this week|last week|last month|last year|year[- ]to[- ]date|ytd)\b/i.test(
      request.message
    );
  if (deterministicMarketSnapshot) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "current_finance",
        reasonCode: "deterministic_market_snapshot",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_market_snapshot",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }
  const deterministicProxyComparison =
    prefetchEntities.length >= 2 &&
    context.quotes.some((quote) => Boolean(quote.proxySymbol));
  if (deterministicProxyComparison) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "comparison",
        reasonCode: "deterministic_proxy_comparison",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_proxy_comparison",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }
  const deterministicInvestabilityComparison =
    prefetchEntities.length >= 2 &&
    prefetchEntities.some((entity) => entity.private) &&
    (context.quotes.length > 0 ||
      context.fundamentals.length > 0 ||
      context.sources.length > 0);
  if (deterministicInvestabilityComparison) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "comparison",
        reasonCode: "deterministic_investability_comparison",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_investability_comparison",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }
  const deterministicStructuredComparison =
    prefetchEntities.length >= 2 &&
    (context.quotes.length >= 2 || context.fundamentals.length >= 2);
  if (deterministicStructuredComparison) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "comparison",
        reasonCode: "deterministic_structured_comparison",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_structured_comparison",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }
  return null;
}

import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import {
  REGULAR_RETRIEVAL_CEILING_MS,
  withDeadline,
  type RequestBudget,
} from "../budget";
import {
  getChatFundamentals,
  getChatQuotes,
  type ChatFundamentals,
  type ChatQuote,
} from "@/lib/market-data";
import type { EvidenceInput } from "../citations";
import {
  readCachedEvidence,
  readCachedPublishedEvidence,
  writeCachedEvidence,
  MISSING_INTELLIGENCE_REVISION,
  type EvidenceRevisions,
} from "./cache";
import {
  filterCommittedArticles,
  readPublishedIntelligence,
} from "@/lib/market-intelligence/repository";
import { classifyMarketIntelligence } from "@/lib/market-intelligence/freshness";
import { requestTickerRefresh } from "@/lib/market-intelligence/queue";
import { evidenceCoverage, filterEvidenceWithDiagnostics } from "./filters";
import {
  retrieveMarketProxy,
  type MarketQuoteFetcher,
  type StooqQuoteFetcher,
} from "./market";
import { astraInput, retrieveAstra } from "./astra";
import { searchTavily } from "../tavily";
import { logStockSage } from "../telemetry";
import type {
  EvidencePlan,
  EvidenceQuery,
  EvidenceBundle,
  EvidenceSource,
  FinanceEntity,
} from "../types";
import type { MarketIntelligenceState } from "@/lib/market-intelligence/types";

export type RegularContext = {
  quotes: ChatQuote[];
  fundamentals: ChatFundamentals[];
  sources: EvidenceSource[];
  coverage: Record<string, "covered" | "missing">;
  plan: EvidencePlan;
  bundle?: EvidenceBundle;
};

export type RetrievalProviders = {
  quotes: (query: EvidenceQuery) => Promise<ChatQuote[]>;
  stooq?: (query: EvidenceQuery) => Promise<ChatQuote[]>;
  marketProxy?: (query: EvidenceQuery) => Promise<ChatQuote[]>;
  fundamentals?: (tickers: string[]) => Promise<ChatFundamentals[]>;
  astra: (
    query: EvidenceQuery,
    entities: FinanceEntity[]
  ) => Promise<EvidenceInput[]>;
  tavily: (query: EvidenceQuery) => Promise<EvidenceInput[]>;
  /** Optional seams keep cache/MI/refresh behavior deterministic in tests. */
  marketIntelligence?: (
    query: EvidenceQuery,
    entities: FinanceEntity[]
  ) => Promise<MarketIntelligenceSnapshot[]>;
  cacheRead?: (
    plan: EvidencePlan,
    entities: FinanceEntity[],
    revisions: EvidenceRevisions
  ) => Promise<EvidenceInput[]>;
  cacheReadPublished?: (
    plan: EvidencePlan,
    entities: FinanceEntity[]
  ) => Promise<{ inputs: EvidenceInput[]; revisions: EvidenceRevisions }>;
  cacheWrite?: (
    plan: EvidencePlan,
    sources: EvidenceSource[],
    revisions: EvidenceRevisions
  ) => Promise<void>;
  refreshTicker?: (
    ticker: string
  ) => Promise<{ joined: boolean; publish: "accepted" | "uncertain" | "suppressed" }>;
};

export type MarketIntelligenceSnapshot = {
  entityId: string;
  ticker: string;
  revision: string;
  state: MarketIntelligenceState;
  inputs: EvidenceInput[];
};

const RETRIEVAL_TIMEOUT_MS = 10_000;
const REFRESH_PUBLICATION_CEILING_MS = 200;

/**
 * Set for the duration of one plan execution so provider helpers inherit the
 * top-level deadline without every call site threading it by hand.
 */
const retrievalDeadline = new AsyncLocalStorage<number>();

function providerTimeoutMs(): number {
  const deadline = retrievalDeadline.getStore();
  if (deadline === undefined) return RETRIEVAL_TIMEOUT_MS;
  return Math.max(0, Math.min(RETRIEVAL_TIMEOUT_MS, deadline - Date.now()));
}

async function bounded<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return withDeadline(promise, providerTimeoutMs(), fallback);
}

async function boundedCall<T>(
  operation: () => Promise<T>,
  fallback: T,
  ceilingMs: number = RETRIEVAL_TIMEOUT_MS
): Promise<T> {
  return withDeadline(
    Promise.resolve().then(operation),
    Math.min(providerTimeoutMs(), ceilingMs),
    fallback
  );
}

async function retrieveQuotes(query: EvidenceQuery): Promise<ChatQuote[]> {
  if (
    query.provider !== "quotes" ||
    query.tickers.length === 0 ||
    (await isOpen("quotes"))
  ) {
    return [];
  }
  try {
    const batches = await Promise.all(
      [...new Set(query.tickers.map((ticker) => ticker.toUpperCase()))].map(
        (ticker) => bounded(getChatQuotes([ticker]), [])
      )
    );
    const quotes = batches.flat();
    if (quotes.length > 0) {
      await recordSuccess("quotes");
    } else {
      await recordFailure("quotes");
    }
    return quotes;
  } catch (error) {
    await recordFailure("quotes");
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "retrieval_failure",
        provider: "quotes",
        reason: error instanceof Error ? error.name : "unknown",
      })}`
    );
    return [];
  }
}

async function readMarketIntelligence(
  query: EvidenceQuery,
  entities: FinanceEntity[]
): Promise<MarketIntelligenceSnapshot[]> {
  if (query.provider !== "astra") return [];
  const perTicker = Math.max(1, Math.floor(query.limit / query.tickers.length));
  return Promise.all(
    query.tickers.map(async (ticker) => {
      const entity = entities.find(
        (candidate) => candidate.ticker?.toUpperCase() === ticker.toUpperCase()
      );
      try {
        const published = await readPublishedIntelligence(ticker);
        const committed = filterCommittedArticles(
          published.articles,
          published.analysis
        ).slice(0, perTicker + 2);
        const analysis = published.analysis;
        const revision =
          analysis?.content_fingerprint ??
          `generation-${analysis?.generation ?? 0}`;
        const state =
          analysis?.analysis_status === "no_news"
            ? ("no_news" as const)
            : classifyMarketIntelligence({
                hasUsableContent: committed.length > 0,
                concludedAt:
                  analysis?.concluded_at ??
                  analysis?.last_success_at ??
                  analysis?.analyzed_at ??
                  analysis?.news_checked_at,
                newsCheckedAt:
                  analysis?.news_checked_at ?? analysis?.last_success_at,
                analysisFingerprint: analysis?.analysis_fingerprint,
                lastErrorCode: analysis?.last_error_code,
              });
        return {
          entityId: entity?.id ?? `ticker:${ticker}`,
          ticker,
          revision,
          state,
          inputs: committed.map((article) =>
            astraInput(article, query, entity?.id)
          ),
        };
      } catch (error) {
        console.error(
          `[stocksage] ${JSON.stringify({
            event: "retrieval_failure",
            provider: "market_intelligence",
            ticker,
            reason: error instanceof Error ? error.name : "unknown",
          })}`
        );
        return {
          entityId: entity?.id ?? `ticker:${ticker}`,
          ticker,
          revision: MISSING_INTELLIGENCE_REVISION,
          state: "degraded" as const,
          inputs: [],
        };
      }
    })
  );
}

export const defaultRetrievalProviders: RetrievalProviders = {
  quotes: retrieveQuotes,
  marketProxy: retrieveMarketProxy,
  fundamentals: getChatFundamentals,
  astra: async (query, entities) => {
    try {
      return await retrieveAstra(query, entities);
    } catch (error) {
      await recordFailure("astra");
      console.error(
        `[stocksage] ${JSON.stringify({
          event: "retrieval_failure",
          provider: "astra",
          reason: error instanceof Error ? error.name : "unknown",
        })}`
      );
      return [];
    }
  },
  tavily: searchTavily,
  marketIntelligence: readMarketIntelligence,
  cacheRead: readCachedEvidence,
  cacheReadPublished: readCachedPublishedEvidence,
  cacheWrite: writeCachedEvidence,
  refreshTicker: (ticker) => requestTickerRefresh(ticker, "user_request"),
};

export async function executeEvidencePlan(args: {
  plan: EvidencePlan;
  entities: FinanceEntity[];
  providers?: RetrievalProviders;
  budget?: RequestBudget;
  /** Overrides the default per-latency-class retrieval ceiling. */
  ceilingMs?: number;
}): Promise<RegularContext> {
  const ceiling =
    args.ceilingMs ??
    (args.budget
      ? Math.min(
          args.budget.latencyClass === "regular"
            ? REGULAR_RETRIEVAL_CEILING_MS
            : RETRIEVAL_TIMEOUT_MS,
          args.budget.publishableMs()
        )
      : RETRIEVAL_TIMEOUT_MS);
  return retrievalDeadline.run(Date.now() + ceiling, () =>
    executeBoundedPlan(args)
  );
}

async function executeBoundedPlan(args: {
  plan: EvidencePlan;
  entities: FinanceEntity[];
  providers?: RetrievalProviders;
}): Promise<RegularContext> {
  const providers = args.providers ?? defaultRetrievalProviders;
  const quoteQueries = args.plan.queries.filter((query) =>
    ["quotes", "stooq", "market_proxy"].includes(query.provider)
  );
  const intelligenceQueries = args.plan.queries.filter(
    (query) => query.provider === "astra"
  );
  const plannedTavily = args.plan.queries.filter(
    (query) => query.provider === "tavily"
  );

  // Phase A: revision-aware Redis, required quote lanes, and committed MI
  // reads begin together.
  const publishedCachePromise = providers.cacheReadPublished
    ? boundedCall(
        () => providers.cacheReadPublished!(args.plan, args.entities),
        { inputs: [], revisions: {} }
      )
    : Promise.resolve(undefined);
  const quoteTasks = quoteQueries.flatMap((query) => {
    const tickers = [
      ...new Set(query.tickers.map((ticker) => ticker.toUpperCase())),
    ];
    if (tickers.length <= 1) return [query];
    return tickers.map((ticker): EvidenceQuery => {
      const entityIds = args.entities
        .filter(
          (entity) =>
            entity.ticker?.toUpperCase() === ticker &&
            query.entityIds.includes(entity.id)
        )
        .map((entity) => entity.id);
      return {
        ...query,
        id: `${query.id}-${ticker.toLowerCase()}`,
        entityIds: entityIds.length > 0 ? entityIds : query.entityIds,
        tickers: [ticker],
        limit: Math.max(1, Math.ceil(query.limit / tickers.length)),
      };
    });
  });
  const quotesPromise = Promise.all(
    quoteTasks.map(async (query) => {
      if (query.provider === "quotes") {
        return boundedCall(() => providers.quotes(query), []);
      }
      if (query.provider === "stooq") {
        return providers.stooq
          ? boundedCall(() => providers.stooq!(query), [])
          : [];
      }
      return providers.marketProxy
        ? boundedCall(() => providers.marketProxy!(query), [])
        : [];
    })
  );
  // Execute MI per entity rather than wrapping a multi-ticker batch in one
  // timeout. Fast snapshots survive when another ticker stalls, and custom
  // Astra providers cannot accidentally attribute a whole batch to the first
  // entity.
  const intelligenceTasks = intelligenceQueries.flatMap((query) => {
    const queryTickers = new Set(
      query.tickers.map((ticker) => ticker.toUpperCase())
    );
    const targets = args.entities.filter(
      (entity) =>
        query.entityIds.includes(entity.id) &&
        entity.ticker &&
        queryTickers.has(entity.ticker.toUpperCase())
    );
    return targets.map(async (entity) => {
      const narrowed: EvidenceQuery = {
        ...query,
        entityIds: [entity.id],
        tickers: [entity.ticker as string],
        limit: Math.max(1, Math.ceil(query.limit / Math.max(1, targets.length))),
      };
      if (providers.marketIntelligence) {
        return boundedCall(
          () => providers.marketIntelligence!(narrowed, [entity]),
          []
        );
      }
      const inputs = await boundedCall(
        () => providers.astra(narrowed, [entity]),
        []
      );
      return [
        {
          entityId: entity.id,
          ticker: entity.ticker as string,
          revision: MISSING_INTELLIGENCE_REVISION,
          state: "fresh" as const,
          inputs,
        },
      ];
    });
  });
  const intelligencePromise = Promise.all(intelligenceTasks);
  const snapshots = (await intelligencePromise).flat();
  const revisions: EvidenceRevisions = Object.fromEntries(
    args.entities.map((entity) => {
      const snapshot = snapshots.find((item) => item.entityId === entity.id);
      return [
        entity.id,
        snapshot?.revision ?? MISSING_INTELLIGENCE_REVISION,
      ];
    })
  );
  const publishedCache = await publishedCachePromise;
  const cachedInputs = publishedCache
    ? publishedCache.inputs.filter((input) =>
        (input.entityIds ?? []).every(
          (entityId) =>
            publishedCache.revisions[entityId] === revisions[entityId]
        )
      )
    : providers.cacheRead
      ? await boundedCall(
          () => providers.cacheRead!(args.plan, args.entities, revisions),
          []
        )
      : [];
  const quotes = (await quotesPromise).flat();
  const intelligenceInputs = snapshots.flatMap((snapshot) => snapshot.inputs);
  const phaseA = filterEvidenceWithDiagnostics({
    inputs: [...cachedInputs, ...intelligenceInputs],
    plan: args.plan,
    entities: args.entities,
  });
  phaseA.diagnostics.cacheHitCount = cachedInputs.length;

  const criteriaByEntity = Object.fromEntries(
    args.entities.map((entity) => [
      entity.id,
      [
        ...new Set(
          args.plan.queries
            .filter(
              (query) =>
                (query.provider === "astra" ||
                  query.provider === "tavily") &&
                query.entityIds.includes(entity.id)
            )
            .flatMap((query) => query.criteria)
        ),
      ],
    ])
  ) as Record<string, string[]>;
  const quotedEntityIds = new Set(
    args.entities
      .filter(
        (entity) =>
          entity.ticker &&
          quotes.some((quote) => quote.ticker === entity.ticker)
      )
      .map((entity) => entity.id)
  );
  const sourceCriteria = (
    sources: EvidenceSource[],
    entityId: string
  ): Set<string> =>
    new Set(
      sources
        .filter((source) => source.entityIds.includes(entityId))
        .flatMap((source) => source.criteria)
    );
  const gapsFor = (
    sources: EvidenceSource[],
    fundamentals: ChatFundamentals[]
  ): Record<string, string[]> =>
    Object.fromEntries(
      args.entities.map((entity) => {
        const covered = sourceCriteria(sources, entity.id);
        if (quotedEntityIds.has(entity.id)) covered.add("performance");
        const item = fundamentals.find(
          (fundamental) => fundamental.ticker === entity.ticker
        );
        if (item?.peTtm != null) covered.add("valuation");
        if (item?.revenueGrowthTtmYoy != null) covered.add("growth");
        if (item?.beta != null) covered.add("risk");
        if (item?.earnings?.actualEps != null) covered.add("earnings");
        return [
          entity.id,
          (criteriaByEntity[entity.id] ?? []).filter(
            (criterion) => !covered.has(criterion)
          ),
        ];
      })
    );

  const initialGaps = gapsFor(phaseA.acceptedSources, []);
  const fundamentalCriteria = new Set([
    "earnings",
    "valuation",
    "growth",
    "risk",
  ]);
  const fundamentalTickers = args.entities
    .filter(
      (entity) =>
        entity.market === "us" &&
        entity.ticker &&
        (initialGaps[entity.id] ?? []).some((criterion) =>
          fundamentalCriteria.has(criterion)
        )
    )
    .map((entity) => entity.ticker as string);

  // Refresh requests are publication only: they never feed this turn and are
  // always awaited, caught, and deduplicated by the queue's ticker reservation.
  const refreshDisposition: Record<string, number> = {};
  const refreshableTickers = [
    ...new Set(
      snapshots.flatMap((snapshot) => {
        const entity = args.entities.find(
          (candidate) => candidate.id === snapshot.entityId
        );
        return (
          snapshot.state === "stale" ||
          snapshot.state === "missing" ||
          snapshot.state === "hard_expired" ||
          snapshot.state === "degraded"
        ) &&
          entity?.ticker &&
          entity.market !== "web" &&
          !entity.private
          ? [entity.ticker]
          : [];
      })
    ),
  ];
  const refreshPromise = Promise.all(
    refreshableTickers.map(async (ticker) => {
      if (!providers.refreshTicker) {
        refreshDisposition.suppressed =
          (refreshDisposition.suppressed ?? 0) + 1;
        return;
      }
      const outcome = await boundedCall<
        | {
            kind: "result";
            result: {
              joined: boolean;
              publish: "accepted" | "uncertain" | "suppressed";
            };
          }
        | { kind: "failed" }
        | { kind: "timeout" }
      >(
        async () => {
          try {
            return {
              kind: "result",
              result: await providers.refreshTicker!(ticker),
            };
          } catch {
            return { kind: "failed" };
          }
        },
        { kind: "timeout" },
        REFRESH_PUBLICATION_CEILING_MS
      );
      if (outcome.kind === "timeout") {
        refreshDisposition.timeout = (refreshDisposition.timeout ?? 0) + 1;
        return;
      }
      if (outcome.kind === "failed") {
        refreshDisposition.failed = (refreshDisposition.failed ?? 0) + 1;
        return;
      }
      {
        const result = outcome.result;
        const disposition =
          result.publish === "suppressed"
            ? "suppressed"
            : result.joined
              ? "joined"
              : result.publish === "accepted"
                ? "requested"
                : "uncertain";
        refreshDisposition[disposition] =
          (refreshDisposition[disposition] ?? 0) + 1;
      }
    })
  );

  // Phase B1: fundamentals are requested only for uncovered supported cells.
  const fundamentals =
    fundamentalTickers.length > 0 && providers.fundamentals
      ? await boundedCall(
          () => providers.fundamentals!(fundamentalTickers),
          []
        )
      : [];
  const postFundamentalGaps = gapsFor(
    phaseA.acceptedSources,
    fundamentals
  );
  const distinctEvidenceHosts = new Set(
    phaseA.acceptedSources.map((source) => {
      try {
        return new URL(source.url).hostname.replace(/^www\./, "");
      } catch {
        return source.outlet.toLowerCase();
      }
    })
  );
  const needsIndependentSource = distinctEvidenceHosts.size < 2;
  let deepCorroborationPlanned = false;
  const gapQueries = plannedTavily.flatMap((query) => {
    const corroborationQuery =
      needsIndependentSource &&
      (args.plan.causal === true ||
        (args.plan.depth === "deep" && !deepCorroborationPlanned));
    if (corroborationQuery && args.plan.depth === "deep") {
      deepCorroborationPlanned = true;
    }
    const entityIds = corroborationQuery
      ? query.entityIds
      : query.entityIds.filter((entityId) =>
          (postFundamentalGaps[entityId] ?? []).some((criterion) =>
            query.criteria.includes(criterion)
          )
        );
    const criteria = [
      ...new Set(
        corroborationQuery
          ? query.criteria
          : entityIds.flatMap((entityId) =>
              (postFundamentalGaps[entityId] ?? []).filter((criterion) =>
                query.criteria.includes(criterion)
              )
            )
      ),
    ];
    if (entityIds.length === 0 || criteria.length === 0) return [];
    const entities = args.entities.filter((entity) =>
      entityIds.includes(entity.id)
    );
    return [
      {
        ...query,
        entityIds,
        tickers: entities
          .map((entity) => entity.ticker)
          .filter((ticker): ticker is string => Boolean(ticker)),
        criteria,
        query: corroborationQuery
          ? `${query.query}. ${
              args.plan.causal
                ? "Find an independent source that corroborates the same-window explanation"
                : "Find an independent source that corroborates the material research claims"
            }`
          : `${entities.map((entity) => entity.query).join(" OR ")} ${criteria.join(" ")}`,
        limit: Math.min(query.limit, Math.max(3, entityIds.length * 3)),
      },
    ];
  });
  const tavilyResults = new Map<string, EvidenceInput[]>();
  const tavilyQueue = [...gapQueries];
  await Promise.all(
    Array.from({ length: Math.min(2, tavilyQueue.length) }, async () => {
      for (;;) {
        const query = tavilyQueue.shift();
        if (!query || providerTimeoutMs() <= 0) return;
        tavilyResults.set(
          query.id,
          await boundedCall(() => providers.tavily(query), [])
        );
      }
    })
  );
  const tavilyInputs = [...tavilyResults.values()].flat();
  const filtered = filterEvidenceWithDiagnostics({
    inputs: [...cachedInputs, ...intelligenceInputs, ...tavilyInputs],
    plan: args.plan,
    entities: args.entities,
  });
  filtered.diagnostics.cacheHitCount = cachedInputs.length;
  const sources = filtered.sources;
  const coverageSources = filtered.acceptedSources;
  if (providers.cacheWrite && sources.length > 0) {
    await boundedCall(
      () => providers.cacheWrite!(args.plan, sources, revisions),
      undefined
    );
  }
  await refreshPromise;
  if (
    filtered.diagnostics.inputCount > 0 ||
    Object.keys(filtered.diagnostics.rejected).length > 0
  ) {
    console.info(
      `[stocksage] ${JSON.stringify({
        event: "evidence_diagnostics",
        accepted: filtered.diagnostics.acceptedCount,
        cacheHits: filtered.diagnostics.cacheHitCount,
        rejected: filtered.diagnostics.rejected,
      })}`
    );
  }
  // Per-provider yield is what tells the AU/US parity report whether a market
  // is thin because a provider has no coverage or because we never asked.
  const finalGaps = gapsFor(coverageSources, fundamentals);
  logStockSage({
    event: "evidence_yield",
    providerCalls: {
      tavily: gapQueries.length,
      astra: intelligenceQueries.length,
      cache: providers.cacheRead || providers.cacheReadPublished ? 1 : 0,
      quotes: quoteQueries.length,
      fundamentals: fundamentalTickers.length > 0 ? 1 : 0,
    },
    yields: {
      tavily: tavilyInputs.length,
      marketIntelligence: intelligenceInputs.length,
      cache: cachedInputs.length,
      quotes: quotes.length,
      fundamentals: fundamentals.length,
      sources: sources.length,
    },
    coverageGaps: finalGaps,
    suppressedProviders: {
      tavily: Math.max(0, plannedTavily.length - gapQueries.length),
      fundamentals:
        providers.fundamentals && fundamentalTickers.length === 0 ? 1 : 0,
    },
    cacheRevisions: revisions,
    refreshDisposition,
    sourceCount: sources.length,
  });

  const coverage = evidenceCoverage({
    plan: args.plan,
    sources: coverageSources,
    quotedEntityIds: [...quotedEntityIds],
  });
  for (const entity of args.entities) {
    if ((criteriaByEntity[entity.id] ?? []).length === 0) continue;
    coverage[entity.id] =
      (finalGaps[entity.id] ?? []).length === 0 ? "covered" : "missing";
  }

  const criteriaCoverage = Object.fromEntries(
    args.entities.map((entity) => [
      entity.id,
      (criteriaByEntity[entity.id] ?? []).filter(
        (criterion) => !(finalGaps[entity.id] ?? []).includes(criterion)
      ),
    ])
  );
  const freshness = Object.fromEntries(
    sources.map((source) => [source.id, source.publishedAt])
  );
  const proxyIdentity = Object.fromEntries(
    quotes.flatMap((quote) =>
      quote.proxySymbol && quote.proxyKind
        ? [
            [
              quote.ticker,
              {
                symbol: quote.proxySymbol,
                kind: quote.proxyKind,
                note: quote.sourceNote,
              },
            ],
          ]
        : []
    )
  );
  return {
    quotes,
    fundamentals,
    sources,
    coverage,
    plan: args.plan,
    bundle: {
      version: 1,
      asOf: args.plan.asOf,
      entityIds: args.entities.map((entity) => entity.id),
      criteria: [
        ...new Set(args.plan.queries.flatMap((query) => query.criteria)),
      ],
      horizon: args.plan.horizon,
      quotes,
      fundamentals,
      sources,
      criteriaCoverage,
      freshness,
      proxyIdentity,
      diagnostics: filtered.diagnostics,
    },
  };
}

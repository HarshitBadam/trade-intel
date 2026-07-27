import "server-only";

import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import {
  getChatFundamentals,
  getChatQuotes,
  type ChatFundamentals,
  type ChatQuote,
} from "@/lib/market-data";
import type { EvidenceInput } from "./citations";
import {
  readCachedEvidence,
  writeCachedEvidence,
} from "./evidence-cache";
import { evidenceCoverage, filterEvidenceWithDiagnostics } from "./evidence";
import {
  retrieveMarketProxy,
  type MarketQuoteFetcher,
  type StooqQuoteFetcher,
} from "./retrieval-market";
import { retrieveAstra } from "./retrieval-astra";
import { searchTavily } from "./tavily";
import type {
  EvidencePlan,
  EvidenceQuery,
  EvidenceBundle,
  EvidenceSource,
  FinanceEntity,
} from "./types";

export { retrieveMarketProxy } from "./retrieval-market";
export type { MarketQuoteFetcher, StooqQuoteFetcher } from "./retrieval-market";
export { astraInput } from "./retrieval-astra";

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
};

const RETRIEVAL_TIMEOUT_MS = 10_000;

async function bounded<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), RETRIEVAL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    const quotes = await bounded(getChatQuotes(query.tickers), []);
    await recordSuccess("quotes");
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
};

export async function executeEvidencePlan(args: {
  plan: EvidencePlan;
  entities: FinanceEntity[];
  providers?: RetrievalProviders;
}): Promise<RegularContext> {
  const providers = args.providers ?? defaultRetrievalProviders;
  const useSharedCache = providers === defaultRetrievalProviders;
  const requestedCriteria = new Set(
    args.plan.queries.flatMap((query) => query.criteria)
  );
  const fundamentalTickers = args.entities
    .filter((entity) => entity.market === "us" && entity.ticker)
    .map((entity) => entity.ticker as string);
  const shouldLoadFundamentals = [
    "earnings",
    "valuation",
    "growth",
    "risk",
  ].some((criterion) => requestedCriteria.has(criterion));
  const tavilyQueue = args.plan.queries.filter(
    (query) => query.provider === "tavily"
  );
  const tavilyResults = new Map<string, EvidenceInput[]>();
  const runTavilyQueue = async (): Promise<void> => {
    const workers = Array.from(
      { length: Math.min(2, tavilyQueue.length) },
      async () => {
        for (;;) {
          const query = tavilyQueue.shift();
          if (!query) return;
          try {
            tavilyResults.set(query.id, await providers.tavily(query));
          } catch {
            tavilyResults.set(query.id, []);
          }
        }
      }
    );
    await Promise.all(workers);
  };
  const [results, fundamentals,, cachedInputs] = await Promise.all([
    Promise.all(
      args.plan.queries.map(async (query) => {
        if (query.provider === "quotes") {
          return { quotes: await providers.quotes(query), inputs: [] };
        }
        if (query.provider === "stooq") {
          if (!providers.stooq) return { quotes: [], inputs: [] };
          try {
            return { quotes: await providers.stooq(query), inputs: [] };
          } catch {
            return { quotes: [], inputs: [] };
          }
        }
        if (query.provider === "market_proxy") {
          if (!providers.marketProxy) return { quotes: [], inputs: [] };
          try {
            return { quotes: await providers.marketProxy(query), inputs: [] };
          } catch {
            return { quotes: [], inputs: [] };
          }
        }
        if (query.provider === "astra") {
          return {
            quotes: [],
            inputs: await providers.astra(query, args.entities),
          };
        }
        return { quotes: [], inputs: [] };
      })
    ),
    shouldLoadFundamentals && providers.fundamentals
      ? bounded(providers.fundamentals(fundamentalTickers), [])
      : Promise.resolve([]),
    runTavilyQueue(),
    useSharedCache
      ? readCachedEvidence(args.plan, args.entities)
      : Promise.resolve([]),
  ]);
  const tavilyInputs = [...tavilyResults.values()].flat();
  const quotes = results.flatMap((result) => result.quotes);
  const freshInputs = [
    ...results.flatMap((result) => result.inputs),
    ...tavilyInputs,
  ];
  const filtered = filterEvidenceWithDiagnostics({
    inputs: [...freshInputs, ...cachedInputs],
    plan: args.plan,
    entities: args.entities,
  });
  const sources = filtered.sources;
  filtered.diagnostics.cacheHitCount = cachedInputs.length;
  if (useSharedCache && sources.length > 0) {
    await writeCachedEvidence(args.plan, sources);
  }
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
  const quotedEntityIds = args.entities
    .filter(
      (entity) =>
        entity.ticker &&
        quotes.some((quote) => quote.ticker === entity.ticker)
    )
    .map((entity) => entity.id);

  const coverage = evidenceCoverage({
    plan: args.plan,
    sources,
    quotedEntityIds,
  });
  for (const entity of args.entities) {
    const item = fundamentals.find(
      (fundamental) => fundamental.ticker === entity.ticker
    );
    if (!item || args.plan.criteria.length === 0) continue;
    const supported = new Set<string>();
    if (item.peTtm !== null) supported.add("valuation");
    if (item.revenueGrowthTtmYoy !== null) supported.add("growth");
    if (item.beta !== null) supported.add("risk");
    if (item.earnings?.actualEps != null) supported.add("earnings");
    if (contextQuoteFor(entity, quotes)) supported.add("performance");
    if (args.plan.criteria.every((criterion) => supported.has(criterion))) {
      coverage[entity.id] = "covered";
    }
  }

  const criteriaCoverage = Object.fromEntries(
    args.entities.map((entity) => [
      entity.id,
      [
        ...new Set(
          sources
            .filter((source) => source.entityIds.includes(entity.id))
            .flatMap((source) => source.criteria)
        ),
      ],
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

function contextQuoteFor(
  entity: FinanceEntity,
  quotes: ChatQuote[]
): ChatQuote | undefined {
  return entity.ticker
    ? quotes.find((quote) => quote.ticker === entity.ticker)
    : undefined;
}

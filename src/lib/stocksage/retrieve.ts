import "server-only";

import { hasAstra } from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import {
  getChatFundamentals,
  getChatQuotes,
  getStooqQuotes,
  readTickerArticles,
  type ChatFundamentals,
  type ChatQuote,
  type StoredArticle,
} from "@/lib/market-data";
import {
  MARKET_PROXY_SYMBOLS,
  STOOQ_SYMBOLS,
} from "./entity-catalog";
import type { EvidenceInput } from "./citations";
import { evidenceCoverage, filterEvidence } from "./evidence";
import { searchTavily } from "./tavily";
import type {
  EvidencePlan,
  EvidenceQuery,
  EvidenceSource,
  FinanceEntity,
} from "./types";

export type RegularContext = {
  quotes: ChatQuote[];
  fundamentals: ChatFundamentals[];
  sources: EvidenceSource[];
  coverage: Record<string, "covered" | "missing">;
  plan: EvidencePlan;
};

export type RetrievalProviders = {
  quotes: (query: EvidenceQuery) => Promise<ChatQuote[]>;
  // Keyless EOD quotes for indices and AU listings; optional so injected
  // test providers without a stooq lane simply skip those queries.
  stooq?: (query: EvidenceQuery) => Promise<ChatQuote[]>;
  // Existing Alpaca→Polygon quote infrastructure first, then Stooq as a
  // non-load-bearing fallback. Proxy metadata is mandatory in the result.
  marketProxy?: (query: EvidenceQuery) => Promise<ChatQuote[]>;
  fundamentals?: (tickers: string[]) => Promise<ChatFundamentals[]>;
  astra: (
    query: EvidenceQuery,
    entities: FinanceEntity[]
  ) => Promise<EvidenceInput[]>;
  tavily: (query: EvidenceQuery) => Promise<EvidenceInput[]>;
};

const RETRIEVAL_TIMEOUT_MS = 10_000;
// Default recency window when a query doesn't set its own freshnessDays.
// Queries that do set one (7 for "today" asks, wider for outlook/risk) must
// win — a fixed pre-filter here silently starved those queries of evidence
// that filterEvidence would have accepted.
const ASTRA_DEFAULT_RECENCY_DAYS = 60;

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

function recentArticle(article: StoredArticle, windowDays: number): boolean {
  const published = Date.parse(article.metadata.publication_date);
  return (
    Number.isFinite(published) &&
    published >= Date.now() - windowDays * 24 * 60 * 60 * 1000
  );
}

export function astraInput(
  article: StoredArticle,
  query: EvidenceQuery,
  entityId: string | undefined
): EvidenceInput {
  const metadata = article.metadata;
  // Surface the stored analysis enrichment (event type, importance,
  // sentiment) alongside the article text so synthesis can use those
  // judgments — with the article's citation — instead of re-deriving them.
  const enrichment = [
    metadata.event ? `Event: ${metadata.event}.` : "",
    metadata.importance ? `Importance: ${metadata.importance}.` : "",
    metadata.sentiment
      ? `Sentiment for ${metadata.ticker || "the stock"}: ${metadata.sentiment}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Enrichment rides ahead of page_content so the 650-char excerpt cap
  // never truncates it away.
  const excerpt = [
    metadata.description,
    metadata.key_observations,
    enrichment,
    article.page_content,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    kind: "astra",
    title: metadata.title,
    outlet: metadata.source,
    publishedAt: metadata.publication_date,
    url: metadata.url,
    excerpt,
    entityIds: entityId ? [entityId] : query.entityIds,
    criteria: query.criteria,
    retrievedAt: new Date().toISOString(),
    queryId: query.id,
  };
}

async function retrieveAstra(
  query: EvidenceQuery,
  entities: FinanceEntity[]
): Promise<EvidenceInput[]> {
  if (
    query.provider !== "astra" ||
    !hasAstra ||
    query.tickers.length === 0 ||
    (await isOpen("astra"))
  ) {
    return [];
  }
  const perTicker = Math.max(1, Math.floor(query.limit / query.tickers.length));
  const batches = await Promise.all(
    query.tickers.map(async (ticker) => {
      try {
        return {
          articles: await bounded(readTickerArticles(ticker, perTicker + 2), []),
          failed: false,
        };
      } catch (error) {
        console.error(
          `[stocksage] ${JSON.stringify({
            event: "retrieval_failure",
            provider: "astra",
            ticker,
            reason: error instanceof Error ? error.name : "unknown",
          })}`
        );
        return { articles: [], failed: true };
      }
    })
  );
  if (batches.every((batch) => batch.failed)) {
    throw new Error("Astra retrieval failed for every requested ticker");
  }

  const windowDays = query.freshnessDays ?? ASTRA_DEFAULT_RECENCY_DAYS;
  const inputs: EvidenceInput[] = [];
  for (let row = 0; row < perTicker; row += 1) {
    for (let index = 0; index < batches.length; index += 1) {
      const articles = batches[index].articles;
      const recent = articles.filter((article) =>
        recentArticle(article, windowDays)
      );
      const ticker = query.tickers[index];
      const entity = entities.find((candidate) => candidate.ticker === ticker);
      if (recent[row]) {
        inputs.push(astraInput(recent[row], query, entity?.id));
      }
    }
  }
  await recordSuccess("astra");
  return inputs;
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

export type MarketQuoteFetcher = (symbols: string[]) => Promise<ChatQuote[]>;
export type StooqQuoteFetcher = (
  pairs: { ticker: string; symbol: string }[]
) => Promise<ChatQuote[]>;

async function fetchProxyCandidates(
  symbols: string[],
  fetcher: MarketQuoteFetcher
): Promise<ChatQuote[]> {
  const output: ChatQuote[] = [];
  for (let index = 0; index < symbols.length; index += 4) {
    try {
      output.push(...(await fetcher(symbols.slice(index, index + 4))));
    } catch {
      // A failed authenticated quote batch falls through to the next proxy
      // candidate and finally Stooq. No partial HTML/body parsing occurs here.
    }
  }
  return output;
}

// Reliable market hierarchy:
// 1) configured Alpaca→Polygon daily bars for a clearly labeled US ETF/ADR;
// 2) a second ETF candidate where defined (ONEQ→QQQ);
// 3) Stooq's direct EOD series, only as a final fallback.
export async function retrieveMarketProxy(
  query: EvidenceQuery,
  quoteFetcher: MarketQuoteFetcher = getChatQuotes,
  stooqFetcher: StooqQuoteFetcher = getStooqQuotes
): Promise<ChatQuote[]> {
  if (query.provider !== "market_proxy" || query.tickers.length === 0) {
    return [];
  }
  const logicalTickers = [
    ...new Set(
      query.tickers.filter((ticker) => Boolean(MARKET_PROXY_SYMBOLS[ticker]))
    ),
  ];
  const resolved = new Map<string, ChatQuote>();
  const quotesAvailable = !(await isOpen("quotes"));
  const maxCandidates = Math.max(
    0,
    ...logicalTickers.map(
      (ticker) => MARKET_PROXY_SYMBOLS[ticker].candidates.length
    )
  );

  if (quotesAvailable) {
    for (let candidateIndex = 0; candidateIndex < maxCandidates; candidateIndex += 1) {
      const candidates = logicalTickers.flatMap((ticker) => {
        if (resolved.has(ticker)) return [];
        const candidate =
          MARKET_PROXY_SYMBOLS[ticker].candidates[candidateIndex];
        return candidate ? [{ ticker, ...candidate }] : [];
      });
      const quotes = await fetchProxyCandidates(
        candidates.map((candidate) => candidate.symbol),
        quoteFetcher
      );
      const bySymbol = new Map(
        quotes.map((quote) => [quote.ticker.toUpperCase(), quote])
      );
      for (const candidate of candidates) {
        const quote = bySymbol.get(candidate.symbol);
        if (!quote) continue;
        const listing = MARKET_PROXY_SYMBOLS[candidate.ticker];
        resolved.set(candidate.ticker, {
          ...quote,
          ticker: candidate.ticker,
          proxySymbol: candidate.symbol,
          proxyKind: listing.kind,
          sourceNote: candidate.note,
          isIndex: false,
        });
      }
    }
  }

  const unresolved = logicalTickers.filter((ticker) => !resolved.has(ticker));
  if (unresolved.length > 0) {
    const pairs = unresolved.flatMap((ticker) => {
      const listing = STOOQ_SYMBOLS[ticker];
      return listing ? [{ ticker, symbol: listing.symbol }] : [];
    });
    let stooqQuotes: ChatQuote[] = [];
    try {
      stooqQuotes = await stooqFetcher(pairs);
    } catch {}
    for (const quote of stooqQuotes) {
      const listing = STOOQ_SYMBOLS[quote.ticker];
      resolved.set(quote.ticker, {
        ...quote,
        sourceNote: listing?.note,
        ...(listing?.index ? { isIndex: true } : {}),
      });
    }
  }

  return logicalTickers.flatMap((ticker) => {
    const quote = resolved.get(ticker);
    return quote ? [quote] : [];
  });
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
          } catch {}
        }
      }
    );
    await Promise.all(workers);
  };
  const [results, fundamentals] = await Promise.all([
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
  ]);
  const tavilyInputs = [...tavilyResults.values()].flat();
  const quotes = results.flatMap((result) => result.quotes);
  const sources = filterEvidence({
    inputs: [...results.flatMap((result) => result.inputs), ...tavilyInputs],
    plan: args.plan,
    entities: args.entities,
  });
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

  return {
    quotes,
    fundamentals,
    sources,
    coverage,
    plan: args.plan,
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

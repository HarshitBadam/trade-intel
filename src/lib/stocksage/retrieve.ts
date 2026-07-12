import "server-only";

import { hasAstra } from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import {
  getChatFundamentals,
  getChatQuotes,
  readTickerArticles,
  type ChatFundamentals,
  type ChatQuote,
  type StoredArticle,
} from "@/lib/market-data";
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
  fundamentals?: (tickers: string[]) => Promise<ChatFundamentals[]>;
  astra: (
    query: EvidenceQuery,
    entities: FinanceEntity[]
  ) => Promise<EvidenceInput[]>;
  tavily: (query: EvidenceQuery) => Promise<EvidenceInput[]>;
};

const RETRIEVAL_TIMEOUT_MS = 10_000;
const ASTRA_RECENCY_DAYS = 60;

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

function recentArticle(article: StoredArticle): boolean {
  const published = Date.parse(article.metadata.publication_date);
  return (
    Number.isFinite(published) &&
    published >= Date.now() - ASTRA_RECENCY_DAYS * 24 * 60 * 60 * 1000
  );
}

function astraInput(
  article: StoredArticle,
  query: EvidenceQuery,
  entityId: string | undefined
): EvidenceInput {
  const metadata = article.metadata;
  const excerpt = [
    metadata.description,
    metadata.key_observations,
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

  const inputs: EvidenceInput[] = [];
  for (let row = 0; row < perTicker; row += 1) {
    for (let index = 0; index < batches.length; index += 1) {
      const articles = batches[index].articles;
      const recent = articles.filter(recentArticle);
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

export const defaultRetrievalProviders: RetrievalProviders = {
  quotes: retrieveQuotes,
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

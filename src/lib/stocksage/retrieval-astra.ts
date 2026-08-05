import "server-only";

import { hasAstra } from "@/lib/config";
import { isOpen, recordSuccess } from "@/lib/breaker";
import type { StoredArticle } from "@/lib/market-data";
import { readTickerArticlesForEvidence } from "@/lib/market-intelligence/repository";
import type { EvidenceInput } from "./citations";
import type { EvidenceQuery, FinanceEntity } from "./types";

const RETRIEVAL_TIMEOUT_MS = 10_000;
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
  const published = Date.parse(
    article.metadata.publication_date || article.metadata.ingested_at || ""
  );
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
  const enrichment = [
    metadata.event ? `Event: ${metadata.event}.` : "",
    metadata.importance ? `Importance: ${metadata.importance}.` : "",
    metadata.sentiment
      ? `Sentiment for ${metadata.ticker || "the stock"}: ${metadata.sentiment}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
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
    publishedAt: metadata.publication_date || metadata.ingested_at,
    url: metadata.url,
    excerpt,
    entityIds: entityId ? [entityId] : query.entityIds,
    criteria: query.criteria,
    retrievedAt: new Date().toISOString(),
    queryId: query.id,
    ticker: metadata.ticker?.trim().toUpperCase(),
    event: metadata.event,
    importance: metadata.importance,
    keyObservations: metadata.key_observations,
    sentiment: metadata.sentiment,
    sentimentReasoning: metadata.sentiment_reasoning,
  };
}

export async function retrieveAstra(
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
          articles: await bounded(
            readTickerArticlesForEvidence(ticker, perTicker + 2),
            []
          ),
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
      const recent = batches[index].articles.filter((article) =>
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

import "server-only";

import { hasAstra } from "@/lib/config";
import {
  getChatQuotes,
  readTickerArticles,
  type ChatQuote,
  type StoredArticle,
} from "@/lib/market-data";
import { createEvidenceSources, type EvidenceInput } from "./citations";
import { isTimeSensitive } from "./intent";
import { searchTavily } from "./tavily";
import type {
  ChatIntent,
  EvidenceSource,
  FinanceEntity,
} from "./types";

export type RegularContext = {
  quotes: ChatQuote[];
  sources: EvidenceSource[];
  topic: "general" | "news";
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

function astraInput(article: StoredArticle): EvidenceInput {
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
  };
}

async function retrieveAstra(tickers: string[]): Promise<EvidenceInput[]> {
  if (!hasAstra || tickers.length === 0) return [];
  const perTicker = Math.max(1, Math.floor(6 / tickers.length));
  const batches = await Promise.all(
    tickers.map((ticker) =>
      bounded(
        readTickerArticles(ticker, perTicker + 2).catch((error) => {
          console.error(`[chat] Astra retrieval failed for ${ticker}:`, error);
          return [];
        }),
        []
      )
    )
  );

  const inputs: EvidenceInput[] = [];
  for (let row = 0; row < perTicker; row += 1) {
    for (const articles of batches) {
      const recent = articles.filter(recentArticle);
      if (recent[row]) inputs.push(astraInput(recent[row]));
    }
  }
  return inputs;
}

function tavilyQuery(message: string, entities: FinanceEntity[]): string {
  const entityContext = entities.map((entity) => entity.query).join("; ");
  return entityContext ? `${message} Context: ${entityContext}` : message;
}

export async function retrieveRegularContext(args: {
  message: string;
  intent: ChatIntent;
  entities: FinanceEntity[];
}): Promise<RegularContext> {
  const usTickers = args.entities
    .filter((entity) => entity.market === "us" && entity.ticker)
    .map((entity) => entity.ticker as string)
    .slice(0, 4);
  const topic = isTimeSensitive(args.intent, args.message) ? "news" : "general";

  const [quotes, astra, tavily] = await Promise.all([
    bounded(getChatQuotes(usTickers).catch(() => []), []),
    retrieveAstra(usTickers),
    searchTavily(tavilyQuery(args.message, args.entities), topic),
  ]);

  return {
    quotes,
    sources: createEvidenceSources([...astra, ...tavily]),
    topic,
  };
}

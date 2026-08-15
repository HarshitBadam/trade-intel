import "server-only";

import { unstable_cache } from "next/cache";
import { DataAPIClient } from "@datastax/astra-db-ts";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
} from "@/lib/config";
import {
  readAnalysisDoc,
  readTickerArticles,
  readTickerArticlesByIds,
} from "../news/store";
import {
  applyPublishedArticleLabels,
  legacyFallbackAllowed,
} from "@/lib/market-intelligence/repository";
import type { News, StoredArticle, AnalysisDoc } from "../types";

async function fetchAstraNews(ticker: string): Promise<News[]> {
  const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
  const database = client.db(ASTRA_DB_API_ENDPOINT!);
  const table = database.collection<News>(ASTRA_DB_NEWS_COLLECTION);
  return table.find({ "metadata.ticker": ticker }).toArray();
}

// Defensive, pure re-assertion of manifest order/membership on top of
// whatever `readTickerArticlesByIds` returned: only rows whose `_id` is in
// `ids` survive, in exactly `ids` order. Any row the store returned that is
// not part of the published manifest (e.g. a staged duplicate) is dropped
// here even if the store-level filter were ever loosened.
export function orderArticlesByManifest<T extends { _id: string }>(
  ids: readonly string[],
  rows: readonly T[]
): T[] {
  const byId = new Map(rows.map((row) => [row._id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is T => Boolean(row));
}

// Manifest-consistent read for the homepage/headline surface: once an
// analysis doc carries `published_article_ids`, that array is the single
// source of truth for which rows are publicly visible, and it is fetched
// by exact id in manifest order so staged rows the worker wrote but never
// published cannot leak into the headline.

// Tickers with no manifest field at all fall back to the legacy unscoped
// read ONLY when that fallback is legal, i.e. `refresh_staging_at` is not
// currently set. An active marker means a refresh is in flight (or died
// mid-flight) for a ticker that has never published, so the raw collection
// may contain this run's unpublished rows: fail closed (no headline) rather
// than risk surfacing them, instead of guessing which legacy row is safe.
async function fetchHeadlineArticles(ticker: string): Promise<News[]> {
  const analysis = await readAnalysisDoc(ticker);
  const ids = analysis?.published_article_ids;
  if (ids) {
    const rows = await readTickerArticlesByIds(ticker, ids);
    return applyPublishedArticleLabels(orderArticlesByManifest(ids, rows), analysis);
  }
  if (!legacyFallbackAllowed(analysis)) {
    return [];
  }
  return fetchAstraNews(ticker);
}

export async function getHeadlineArticlesCached(ticker: string): Promise<News[]> {
  const symbol = ticker.trim().toUpperCase();
  return unstable_cache(
    () => fetchHeadlineArticles(symbol),
    ["headline-articles", symbol],
    { revalidate: 600, tags: [`news:${symbol}`] }
  )();
}

async function readStoredTickerArticles(ticker: string): Promise<StoredArticle[]> {
  return readTickerArticles(ticker, 200);
}

export async function readStoredArticlesCached(
  ticker: string
): Promise<StoredArticle[]> {
  const symbol = ticker.trim().toUpperCase();
  return unstable_cache(
    () => readStoredTickerArticles(symbol),
    ["store-ticker-articles", symbol],
    { revalidate: 600, tags: [`news:${symbol}`] }
  )();
}

export async function readStoredArticlesByIdsCached(
  ticker: string,
  ids: readonly string[]
): Promise<StoredArticle[]> {
  const symbol = ticker.trim().toUpperCase();
  const stableIds = [...ids];
  return unstable_cache(
    () => readTickerArticlesByIds(symbol, stableIds),
    ["store-ticker-articles-by-id", symbol, stableIds.join(",")],
    { revalidate: 600, tags: [`news:${symbol}`] }
  )();
}

async function readTickerAnalysis(ticker: string): Promise<AnalysisDoc | null> {
  return readAnalysisDoc(ticker);
}

export async function readAnalysisDocCached(
  ticker: string
): Promise<AnalysisDoc | null> {
  const symbol = ticker.trim().toUpperCase();
  return unstable_cache(
    () => readTickerAnalysis(symbol),
    ["store-analysis-doc", symbol],
    { revalidate: 600, tags: [`news:${symbol}`] }
  )();
}

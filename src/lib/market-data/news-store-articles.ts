import "server-only";

import { createHash } from "node:crypto";
import type { StoredArticle } from "./types";
import { newsCollection } from "./news-store-client";

const UPSERT_CONCURRENCY = 8;
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
]);

function isTrackingParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized);
}

function normalizeArticleUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "#") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ""}`;
}

// Provider-independent IDs make repeated ingestion idempotent. The fallback
// must include ticker, title, and publication date at the call site.
export function stableArticleId(
  url: string | null | undefined,
  fallback: string
): string {
  const basis = normalizeArticleUrl(url) ?? fallback;
  return `art_${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

// A provider reload must not overwrite labels owned by the AI analysis pass.
export async function upsertArticles(
  ticker: string,
  articles: StoredArticle[]
): Promise<{ upserted: number; inserted: number; skippedAi: number }> {
  if (articles.length === 0) return { upserted: 0, inserted: 0, skippedAi: 0 };
  const symbol = ticker.trim().toUpperCase();
  const collection = newsCollection();
  const aiRows = await collection
    .find(
      { "metadata.ticker": symbol, "metadata.label_source": "ai" },
      { projection: { _id: 1 } }
    )
    .toArray();
  const aiIds = new Set(aiRows.map((row) => row._id));
  const pending = articles.filter((article) => !aiIds.has(article._id));

  let inserted = 0;
  for (let i = 0; i < pending.length; i += UPSERT_CONCURRENCY) {
    const chunk = pending.slice(i, i + UPSERT_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(({ _id, ...fields }) =>
        collection.updateOne({ _id }, { $set: fields }, { upsert: true })
      )
    );
    for (const result of results) inserted += result.upsertedCount;
  }
  return {
    upserted: pending.length,
    inserted,
    skippedAi: articles.length - pending.length,
  };
}

// Only analysis-owned fields are updated; provider-owned article fields remain
// untouched and label_source fences them from later provider reloads.
export async function applyArticleLabels(
  updates: {
    _id: string;
    sentiment: string;
    importance: string;
    key_observations: string;
  }[]
): Promise<number> {
  if (updates.length === 0) return 0;
  const collection = newsCollection();
  let modified = 0;
  for (let i = 0; i < updates.length; i += UPSERT_CONCURRENCY) {
    const chunk = updates.slice(i, i + UPSERT_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((update) =>
        collection.updateOne(
          { _id: update._id },
          {
            $set: {
              "metadata.sentiment": update.sentiment,
              "metadata.importance": update.importance,
              "metadata.key_observations": update.key_observations,
              "metadata.label_source": "ai",
            },
          }
        )
      )
    );
    for (const result of results) modified += result.modifiedCount;
  }
  return modified;
}

function articleTimestamp(article: StoredArticle): number {
  const published = Date.parse(article.metadata?.publication_date ?? "");
  if (Number.isFinite(published)) return published;
  const ingested = Date.parse(article.metadata?.ingested_at ?? "");
  return Number.isFinite(ingested) ? ingested : 0;
}

export async function readTickerArticles(
  ticker: string,
  limit = 10
): Promise<StoredArticle[]> {
  const symbol = ticker.trim().toUpperCase();
  const aliases = [...new Set([symbol, symbol.toLowerCase()])];
  const rows = await newsCollection()
    .find(
      { "metadata.ticker": { $in: aliases } },
      {
        sort: { "metadata.publication_date": -1 },
        limit: Math.max(limit, Math.min(100, limit * 3)),
      }
    )
    .toArray();
  return rows
    .sort((left, right) => articleTimestamp(right) - articleTimestamp(left))
    .slice(0, limit);
}

export async function readTickerArticlesByIds(
  ticker: string,
  ids: readonly string[]
): Promise<StoredArticle[]> {
  if (ids.length === 0) return [];
  const symbol = ticker.trim().toUpperCase();
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  const rows = await newsCollection()
    .find({
      _id: { $in: uniqueIds },
      "metadata.ticker": { $in: [symbol, symbol.toLowerCase()] },
    })
    .toArray();
  const byId = new Map(rows.map((row) => [row._id, row]));
  return uniqueIds
    .map((id) => byId.get(id))
    .filter((row): row is StoredArticle => Boolean(row));
}

export async function countTickerArticles(ticker: string): Promise<number> {
  return newsCollection().countDocuments(
    { "metadata.ticker": ticker.trim().toUpperCase() },
    1000
  );
}

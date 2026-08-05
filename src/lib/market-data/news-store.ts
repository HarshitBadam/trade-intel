import "server-only";

import { createHash } from "node:crypto";
import {
  DataAPIClient,
  type Collection,
  type Db,
} from "@datastax/astra-db-ts";
import {
  ASTRA_DB_ANALYSIS_COLLECTION,
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
} from "@/lib/config";
import type { AnalysisDoc, StoredArticle } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db | null = null;

export function astraDb(): Db {
  if (!db) {
    db = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!).db(ASTRA_DB_API_ENDPOINT!);
  }
  return db;
}

function newsCollection(): Collection<StoredArticle> {
  return astraDb().collection<StoredArticle>(ASTRA_DB_NEWS_COLLECTION);
}

export async function listNewsStoreCollections(): Promise<string[]> {
  return astraDb().listCollections({ nameOnly: true });
}

export type AnalysisMode = "separate" | "fallback";

// Marks a verdict row when it has to live in the news collection (fallback mode).
// Namespacing the `_id` (`analysis_<TICKER>`) keeps it out of article reads;
// this field just makes the intent legible.
const ANALYSIS_DOC_TYPE = "ticker_analysis";

let analysisMode: AnalysisMode | null = null;

// Create the analysis collection (plain, non-vector, verdicts are read by key,
// never similarity-searched, and vector collections weigh more against the free-tier
// collection cap). Safe to call repeatedly: `checkExists: false` makes an exact
// re-create a no-op. If creation fails AND the collection still isn't listed, we
// assume the free-tier cap and fall back to co-locating verdicts in the news collection.
export async function ensureAnalysisCollection(): Promise<AnalysisMode> {
  if (analysisMode) return analysisMode;
  const existing = await listNewsStoreCollections().catch(() => [] as string[]);
  if (existing.includes(ASTRA_DB_ANALYSIS_COLLECTION)) {
    analysisMode = "separate";
    return analysisMode;
  }
  try {
    await astraDb().createCollection(ASTRA_DB_ANALYSIS_COLLECTION, {
      checkExists: false,
    });
    analysisMode = "separate";
  } catch (error) {
    const now = await listNewsStoreCollections().catch(() => [] as string[]);
    if (now.includes(ASTRA_DB_ANALYSIS_COLLECTION)) {
      analysisMode = "separate";
    } else {
      console.error(
        `[news-store] could not create ${ASTRA_DB_ANALYSIS_COLLECTION} ` +
          `(likely the free-tier collection cap); co-locating verdicts in ` +
          `${ASTRA_DB_NEWS_COLLECTION} under doc_type="${ANALYSIS_DOC_TYPE}":`,
        error
      );
      analysisMode = "fallback";
    }
  }
  return analysisMode;
}

async function analysisRef(ticker: string): Promise<{
  collection: Collection<AnalysisDoc>;
  id: string;
  onInsert: Partial<AnalysisDoc> & Record<string, unknown>;
}> {
  const mode = await ensureAnalysisCollection();
  const symbol = ticker.trim().toUpperCase();
  if (mode === "separate") {
    return {
      collection: astraDb().collection<AnalysisDoc>(ASTRA_DB_ANALYSIS_COLLECTION),
      id: symbol,
      onInsert: { ticker: symbol },
    };
  }
  return {
    collection: newsCollection() as unknown as Collection<AnalysisDoc>,
    id: `analysis_${symbol}`,
    onInsert: { ticker: symbol, doc_type: ANALYSIS_DOC_TYPE },
  };
}

// Query params that only track the click, never identify the article. Kept to
// a conservative, well-known set, over-stripping would merge genuinely different
// URLs into one id.
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
  return key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase());
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
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ""}`;
}

// Stable, provider-independent article id: sha256 of the normalized URL, or of
// the caller-supplied fallback (`ticker|title|publication_date`) when there is
// no usable URL. 24 hex chars ≈ 96 bits, collision-safe at our scale while
// staying short enough to read in logs and `key_drivers.article_ids`.
export function stableArticleId(
  url: string | null | undefined,
  fallback: string
): string {
  const basis = normalizeArticleUrl(url) ?? fallback;
  return `art_${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

const UPSERT_CONCURRENCY = 8;

// Idempotent per-article upsert keyed on `_id = article_id`. Rows the deep pass
// has already relabeled (label_source "ai") are left untouched, a routine re-load
// must not downgrade AI labels back to interim provider ones.
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

// Apply the deep pass's per-article labels IN PLACE. Only the four fields the
// LLM owns are $set; titles/urls/dates are untouched. `label_source` flips to
// "ai", which is exactly what upsertArticles keys off to protect these rows
// from a later provider re-load downgrading them.
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
      chunk.map((u) =>
        collection.updateOne(
          { _id: u._id },
          {
            $set: {
              "metadata.sentiment": u.sentiment,
              "metadata.importance": u.importance,
              "metadata.key_observations": u.key_observations,
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
  const timestamp = (article: StoredArticle): number => {
    const published = Date.parse(article.metadata?.publication_date ?? "");
    if (Number.isFinite(published)) return published;
    const ingested = Date.parse(article.metadata?.ingested_at ?? "");
    return Number.isFinite(ingested) ? ingested : 0;
  };
  return rows.sort((left, right) => timestamp(right) - timestamp(left)).slice(0, limit);
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

export async function readAnalysisDoc(ticker: string): Promise<AnalysisDoc | null> {
  const { collection, id } = await analysisRef(ticker);
  return collection.findOne({ _id: id });
}

// $set only the provided fields, so a verdict write never clobbers
// `news_loaded_at` (and vice versa), the two writers own disjoint fields.
export async function writeAnalysisDoc(doc: AnalysisDoc): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(doc._id ?? doc.ticker);
  const { _id: _ignored, ...fields } = doc;
  await collection.updateOne(
    { _id: id },
    { $set: { ...fields, ...onInsert } },
    { upsert: true }
  );
}

/**
 * Pure shape of the manifest CAS update: every successful publish clears
 * `refresh_staging_at` unconditionally, regardless of what the caller's
 * `doc` happens to carry (it is stripped out of `$set` and always
 * `$unset`). Reaching a real publish means the in-flight refresh produced a
 * durable manifest (or explicit no_news/news-only bundle), so the staging
 * marker's job of telling no-manifest readers "a refresh is in flight, fail
 * closed" is done. Exported standalone so this invariant is testable
 * without a live Astra connection.
 */
export function buildManifestPublishUpdate(doc: AnalysisDoc): {
  fields: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const { _id: _ignored, refresh_staging_at: _stagingIgnored, ...fields } = doc;
  return { fields, unset: { refresh_staging_at: "" } };
}

/**
 * Publishes the single authoritative manifest only if the analysis generation
 * still matches what the worker originally read. Article rows may be staged
 * earlier, but readers cannot see them until their ids appear in this document.
 */
export async function publishAnalysisDoc(
  doc: AnalysisDoc,
  expectedGeneration: number | null
): Promise<boolean> {
  const { collection, id, onInsert } = await analysisRef(doc._id ?? doc.ticker);
  const { fields, unset } = buildManifestPublishUpdate(doc);
  const generationFilter =
    expectedGeneration === null
      ? { generation: { $exists: false } }
      : { generation: expectedGeneration };
  const result = await collection.updateOne(
    { _id: id, ...generationFilter },
    {
      $set: { ...fields, ...onInsert },
      $unset: unset,
    },
    { upsert: expectedGeneration === null }
  );
  return result.modifiedCount > 0 || result.upsertedCount > 0;
}

// Written immediately before the worker upserts newly fetched article rows,
// so the window between "rows exist in storage" and "a manifest/watermark
// vouches for them" is never silently mistaken for genuine legacy data by a
// no-manifest reader. `$set`-only and ungated by generation, mirroring
// `touchNewsLoadedAt`: this is a heads-up marker, not part of the CAS'd
// manifest itself.
export async function markRefreshStaging(
  ticker: string,
  when: string = new Date().toISOString()
): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(ticker);
  await collection.updateOne(
    { _id: id },
    { $set: { ...onInsert, refresh_staging_at: when } },
    { upsert: true }
  );
}

// Stamped by the news loader after a successful article load. Deliberately NOT
// `analyzed_at`: staleness of the verdict is judged from `analyzed_at` alone,
// which only the analysis pass may write.
export async function touchNewsLoadedAt(
  ticker: string,
  when: string = new Date().toISOString()
): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(ticker);
  await collection.updateOne(
    { _id: id },
    { $set: { ...onInsert, news_loaded_at: when } },
    { upsert: true }
  );
}

export async function recordAnalysisError(
  ticker: string,
  errorCode: string
): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(ticker);
  await collection.updateOne(
    { _id: id },
    { $set: { ...onInsert, last_error_code: errorCode } },
    { upsert: true }
  );
}

function prunableFilter(cutoffDay: string) {
  // `publication_date` is "YYYY-MM-DD", so lexicographic comparison IS
  // chronological. `$exists` + `$gt: ""` protect docs with a missing or empty
  // date (some legacy Langflow rows), an undated row must never be deleted.
  return {
    "metadata.publication_date": { $exists: true, $gt: "", $lt: cutoffDay },
  };
}

function pruneCutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

export async function countPrunableArticles(days = 90): Promise<number> {
  return newsCollection().countDocuments(prunableFilter(pruneCutoff(days)), 1000);
}

// astra-db-ts's deleteMany re-issues the command while the API reports `moreData`,
// so one call drains every match and returns the total.
export async function pruneOldArticles(days = 90): Promise<number> {
  const result = await newsCollection().deleteMany(prunableFilter(pruneCutoff(days)));
  return result.deletedCount;
}

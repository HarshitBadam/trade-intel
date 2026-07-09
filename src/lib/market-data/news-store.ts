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

// The single write/ops surface for the news store (redesign §0/§14): the cron
// lanes load articles and the analysis pass writes verdicts THROUGH this
// module, so Next.js is the only Astra writer. The request path keeps reading
// via cache.ts; nothing here runs per-request.
//
// Collections: article rows stay in the legacy news collection (the vector one
// Langflow wrote), so old and new rows serve from one query. Analysis docs
// PREFER their own small non-vector collection; if the free-tier collection cap
// blocks creating it, they degrade to the news collection under a `doc_type`
// discriminator (see ensureAnalysisCollection). Either way article reads filter
// on `metadata.ticker` — which verdict docs never carry — so a verdict can
// never contaminate a news read.

const DAY_MS = 24 * 60 * 60 * 1000;

// One client per process: config is parsed once and every helper (plus any
// future cron caller) shares the connection pool instead of re-instantiating
// per call the way the legacy read path does.
let db: Db | null = null;

export function astraDb(): Db {
  if (!db) {
    db = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!).db(
      ASTRA_DB_API_ENDPOINT!
    );
  }
  return db;
}

function newsCollection(): Collection<StoredArticle> {
  return astraDb().collection<StoredArticle>(ASTRA_DB_NEWS_COLLECTION);
}

export async function listNewsStoreCollections(): Promise<string[]> {
  return astraDb().listCollections({ nameOnly: true });
}

// ─── Analysis store location (separate collection, with a cap fallback) ──────

export type AnalysisMode = "separate" | "fallback";

// Marks a verdict row when it has to live in the news collection (fallback
// mode). Namespacing the `_id` (`analysis_<TICKER>`) is what actually keeps it
// out of article reads; this field just makes the intent legible.
const ANALYSIS_DOC_TYPE = "ticker_analysis";

// Resolved once per process by ensureAnalysisCollection; every analysis op waits
// on it so reads and writes agree on where verdicts live.
let analysisMode: AnalysisMode | null = null;

// Create the analysis collection (plain, non-vector — verdicts are read by key,
// never similarity-searched, and vector collections weigh more against the
// free-tier collection cap). Safe to call repeatedly: `checkExists: false`
// makes an exact re-create a no-op. If creation fails AND the collection still
// isn't listed, we assume the free-tier cap and fall back to co-locating
// verdicts in the news collection rather than breaking the whole store.
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

// Where a ticker's verdict doc lives + how it's keyed, per the resolved mode.
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

// ─── Article identity ────────────────────────────────────────────────────────

// Query params that only track the click, never identify the article. Kept to
// a conservative, well-known set — over-stripping would merge genuinely
// different URLs into one id.
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

// Canonical form of an article URL so the same story hashes to the same id no
// matter which tracking decoration a provider appended. `new URL` already
// lowercases scheme+host; we drop the fragment and tracking params and sort
// what remains so param order can't split identities.
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
// no usable URL. 24 hex chars ≈ 96 bits — collision-safe at our scale while
// staying short enough to read in logs and `key_drivers.article_ids`.
export function stableArticleId(
  url: string | null | undefined,
  fallback: string
): string {
  const basis = normalizeArticleUrl(url) ?? fallback;
  return `art_${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

// ─── Article writes ──────────────────────────────────────────────────────────

const UPSERT_CONCURRENCY = 8;

// Idempotent per-article upsert keyed on `_id = article_id`: re-running a load
// rewrites the same rows instead of duplicating them, which is why this is an
// updateOne loop rather than one insertMany (insertMany can't upsert; ordered
// error-handling around duplicate keys is messier than it's worth for a
// cron-side write). Rows the deep pass has already relabeled
// (label_source "ai") are left untouched — a routine re-load must not
// downgrade AI labels back to interim provider ones, and the loader has
// nothing new to say about an article it already stored.
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

// Apply the deep pass's per-article labels IN PLACE (redesign §5/D6: the gauge
// refines on the same stored set rather than swapping in a different one). Only
// the four fields the LLM owns are $set, keyed by `_id`, so titles/urls/dates
// are untouched. `label_source` flips to "ai" — which is exactly what
// upsertArticles keys off to protect these rows from a later provider re-load
// downgrading them. Batched at the same concurrency as upsertArticles. Lives
// here (not in analysis.ts) so Astra remains the news-store's single writer.
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

// Newest-first read of a ticker's stored rows. Exists for ops/diagnosis (and
// as the natural backend for the future store-first request path) — the live
// request path still reads through cache.ts today.
export async function readTickerArticles(
  ticker: string,
  limit = 10
): Promise<StoredArticle[]> {
  return newsCollection()
    .find(
      { "metadata.ticker": ticker.trim().toUpperCase() },
      { sort: { "metadata.publication_date": -1 }, limit }
    )
    .toArray();
}

// Total stored rows for a ticker — used to prove idempotent re-loads don't grow
// the collection. Bounded at the Data API's 1000-doc counting cap (far above a
// single ticker's article count).
export async function countTickerArticles(ticker: string): Promise<number> {
  return newsCollection().countDocuments(
    { "metadata.ticker": ticker.trim().toUpperCase() },
    1000
  );
}

// ─── Analysis docs (one per ticker, `_id` = uppercased symbol) ───────────────

export async function readAnalysisDoc(
  ticker: string
): Promise<AnalysisDoc | null> {
  const { collection, id } = await analysisRef(ticker);
  return collection.findOne({ _id: id });
}

// $set only the provided fields, so a verdict write never clobbers
// `news_loaded_at` (and vice versa) — the two writers own disjoint fields.
export async function writeAnalysisDoc(doc: AnalysisDoc): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(doc._id ?? doc.ticker);
  const { _id: _ignored, ...fields } = doc;
  // On upsert Astra assigns `_id` from the filter equality, so it is never in
  // the update body. `onInsert` (ticker, and doc_type in fallback mode) is kept
  // in `$set` because those values are stable identity, not per-write data.
  await collection.updateOne(
    { _id: id },
    { $set: { ...fields, ...onInsert } },
    { upsert: true }
  );
}

// Stamped by the news loader after a successful article load. Deliberately
// NOT `analyzed_at`: staleness of the verdict is judged from `analyzed_at`
// alone (redesign §11), which only the analysis pass may write.
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

// ─── Retention (redesign §9: storage hygiene only) ───────────────────────────

function prunableFilter(cutoffDay: string) {
  // publication_date is stored as "YYYY-MM-DD", so lexicographic comparison IS
  // chronological. `$exists` + `$gt: ""` protect docs with a missing or empty
  // date (some legacy Langflow rows) — an undated row must never be deleted.
  return {
    "metadata.publication_date": { $exists: true, $gt: "", $lt: cutoffDay },
  };
}

function pruneCutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

// Dry-run companion to pruneOldArticles: how many rows WOULD go. Throws
// TooManyDocumentsToCountError past the Data API's 1000-doc counting cap.
export async function countPrunableArticles(days = 90): Promise<number> {
  return newsCollection().countDocuments(prunableFilter(pruneCutoff(days)), 1000);
}

// Delete article rows older than the retention window. astra-db-ts's
// deleteMany already re-issues the command while the API reports `moreData`,
// so one call drains every match and returns the total.
export async function pruneOldArticles(days = 90): Promise<number> {
  const result = await newsCollection().deleteMany(
    prunableFilter(pruneCutoff(days))
  );
  return result.deletedCount;
}

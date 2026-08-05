import "server-only";

import { GROQ_ANALYSIS_MODEL } from "@/lib/config";
import {
  readAnalysisDoc,
  readTickerArticles,
  readTickerArticlesByIds,
} from "@/lib/market-data/news-store";
import { MAX_ARTICLES_PER_PASS } from "@/lib/market-data/analysis-helpers";
import { dedupeNews, windowNews } from "@/lib/market-data/transforms";
import type { AnalysisDoc, StoredArticle } from "@/lib/market-data/types";
import {
  createAnalysisFingerprint,
  createContentFingerprint,
  createContentRevision,
} from "./fingerprints";

export const MARKET_PIPELINE_VERSION = "market-intelligence-v1";
export const ANALYSIS_PROMPT_VERSION = "stocksage-analysis-v1";
export const SOURCE_WINDOW_DAYS = 90;

export type CandidateSet = {
  articles: StoredArticle[];
  articleIds: string[];
  contentFingerprint: string;
  analysisFingerprint: string;
};

export function applyPublishedArticleLabels(
  articles: readonly StoredArticle[],
  analysis: AnalysisDoc | null
): StoredArticle[] {
  const labels = new Map(
    (analysis?.published_article_labels ?? []).map((label) => [
      label.article_id,
      label,
    ])
  );
  return articles.map((article) => {
    const label = labels.get(article._id);
    if (!label) return article;
    return {
      ...article,
      metadata: {
        ...article.metadata,
        sentiment: label.sentiment,
        importance: label.importance,
        key_observations: label.key_observations,
        label_source: "ai",
      },
    };
  });
}

// Evidence fetches look further back than the requested `limit` so that,
// after `filterCommittedArticles` drops anything staged post-watermark, there
// is still enough committed history left to fill the request.
const EVIDENCE_FETCH_MULTIPLIER = 4;
const EVIDENCE_FETCH_CAP = 200;

/**
 * Shared gate for every "no manifest yet" legacy fallback (homepage
 * headline, details article list, `readPublishedIntelligence`): the
 * unscoped raw read is only legal when no refresh is currently staging
 * unpublished rows for this ticker. Once `refresh_staging_at` is set, a
 * worker run is in flight (or died mid-flight) without ever publishing, so
 * callers must fail closed instead of risking exposure of this run's
 * unpublished fetch.
 */
export function legacyFallbackAllowed(analysis: AnalysisDoc | null): boolean {
  return !analysis?.refresh_staging_at;
}

/**
 * A row is safe for evidence if it is either part of the current published
 * manifest (always allowed, even if ingested after the watermark) or was
 * already ingested by the time the last successful publication happened
 * (`last_success_at`), i.e. committed history the worker had already
 * accounted for. Rows ingested after that watermark that never made it into
 * the manifest are staged/unpublished and must not be cited.
 *
 * When there is no watermark at all (no analysis doc, or an analysis doc
 * that has never completed a successful publish), the ticker has never had
 * a successful worker run, so `last_success_at`/`published_article_ids`
 * can't tell staged rows from genuine legacy ones. In that case
 * `refresh_staging_at` is the only signal available:
 *  - unset: nothing has ever staged rows for this ticker, so whatever is in
 *    storage is genuine pre-existing legacy history (backward compatible).
 *  - set: a refresh is currently in flight (or died mid-flight without ever
 *    publishing), so rows ingested at/after that marker are this run's
 *    unpublished fetch and must be excluded; rows strictly older than the
 *    marker predate this run and remain visible as legacy history.
 */
export function filterCommittedArticles(
  articles: readonly StoredArticle[],
  analysis: AnalysisDoc | null
): StoredArticle[] {
  const watermark = analysis?.last_success_at
    ? Date.parse(analysis.last_success_at)
    : NaN;
  if (Number.isFinite(watermark)) {
    const publishedIds = new Set(analysis?.published_article_ids ?? []);
    return articles.filter((article) => {
      if (publishedIds.has(article._id)) return true;
      const ingested = Date.parse(article.metadata.ingested_at ?? "");
      return Number.isFinite(ingested) && ingested <= watermark;
    });
  }

  const stagingAt = analysis?.refresh_staging_at
    ? Date.parse(analysis.refresh_staging_at)
    : NaN;
  if (!Number.isFinite(stagingAt)) {
    return [...articles];
  }
  return articles.filter((article) => {
    const ingested = Date.parse(article.metadata.ingested_at ?? "");
    return Number.isFinite(ingested) && ingested < stagingAt;
  });
}

export async function readTickerArticlesForEvidence(
  ticker: string,
  limit: number
): Promise<StoredArticle[]> {
  const symbol = ticker.trim().toUpperCase();
  const fetchLimit = Math.min(
    EVIDENCE_FETCH_CAP,
    Math.max(limit, limit * EVIDENCE_FETCH_MULTIPLIER)
  );
  const [articles, analysis] = await Promise.all([
    readTickerArticles(symbol, fetchLimit),
    readAnalysisDoc(symbol),
  ]);
  const committed = filterCommittedArticles(articles, analysis);
  return applyPublishedArticleLabels(committed, analysis).slice(0, limit);
}

export async function selectCandidateSet(ticker: string): Promise<CandidateSet> {
  const symbol = ticker.trim().toUpperCase();
  const stored = await readTickerArticles(symbol, 200);
  const articles = dedupeNews(windowNews(stored, SOURCE_WINDOW_DAYS))
    .slice(0, MAX_ARTICLES_PER_PASS) as StoredArticle[];
  const contentFingerprint = createContentFingerprint(
    symbol,
    articles.map((article) => ({
      articleId: article._id,
      publicationDate: article.metadata.publication_date ?? "",
      contentRevision: createContentRevision({
        title: article.metadata.title,
        description: article.metadata.description,
        pageContent: article.page_content,
      }),
    }))
  );
  return {
    articles,
    articleIds: articles.map((article) => article._id),
    contentFingerprint,
    analysisFingerprint: createAnalysisFingerprint({
      contentFingerprint,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      model: GROQ_ANALYSIS_MODEL,
    }),
  };
}

export async function readPublishedIntelligence(ticker: string): Promise<{
  analysis: AnalysisDoc | null;
  articles: StoredArticle[];
  legacy: boolean;
}> {
  const symbol = ticker.trim().toUpperCase();
  const analysis = await readAnalysisDoc(symbol);
  const ids = analysis?.published_article_ids;
  if (ids) {
    const articles = await readTickerArticlesByIds(symbol, ids);
    return {
      analysis,
      articles: applyPublishedArticleLabels(articles, analysis),
      legacy: false,
    };
  }
  if (!legacyFallbackAllowed(analysis)) {
    return { analysis, articles: [], legacy: true };
  }
  return {
    analysis,
    articles: await readTickerArticles(symbol, MAX_ARTICLES_PER_PASS),
    legacy: true,
  };
}

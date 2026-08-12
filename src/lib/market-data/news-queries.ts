import "server-only";

import type { News } from "@/components/news/RecentInfluential";
import type { NewsVerdict } from "@/components/news/VerdictModal";
import { generateMockPopularity } from "@/data/fallbacks";
import {
  GROQ_ANALYSIS_MODEL,
  hasAlpaca,
  hasAstra,
  hasFinnhub,
  hasPolygon,
} from "@/lib/config";
import { createAnalysisFingerprint } from "@/lib/market-intelligence/fingerprints";
import { classifyMarketIntelligence } from "@/lib/market-intelligence/freshness";
import {
  ANALYSIS_PROMPT_VERSION,
  applyPublishedArticleLabels,
  legacyFallbackAllowed,
} from "@/lib/market-intelligence/repository";
import {
  readAnalysisDocCached,
  readStoredArticlesByIdsCached,
  readStoredArticlesCached,
} from "./cache";
import {
  buildPopularitySeries,
  computePopularityScore,
  dedupeNews,
  latestNewsTimestamp,
  POPULARITY_WINDOW_DAYS,
  summarizeNews,
  windowNews,
} from "./transforms";
import type {
  AnalysisDoc,
  NewsSummary,
  PopularityData,
  StoredArticle,
} from "./types";

const hasAnyLiveSource = hasAlpaca || hasPolygon || hasFinnhub || hasAstra;

function expectedAnalysisFingerprint(
  doc: AnalysisDoc | null
): string | undefined {
  if (!doc?.content_fingerprint) return undefined;
  return createAnalysisFingerprint({
    contentFingerprint: doc.content_fingerprint,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    model: GROQ_ANALYSIS_MODEL,
  });
}

export async function fetchStoredArticles(
  ticker: string,
  analysisDoc: AnalysisDoc | null
): Promise<StoredArticle[]> {
  if (!hasAstra) return [];
  try {
    if (analysisDoc?.published_article_ids) {
      const rows = await readStoredArticlesByIdsCached(
        ticker,
        analysisDoc.published_article_ids
      );
      return applyPublishedArticleLabels(rows, analysisDoc);
    }
    // Without a manifest, unscoped legacy reads must fail closed while a
    // refresh is staging rows that have not passed the publication CAS.
    if (!legacyFallbackAllowed(analysisDoc)) return [];
    return await readStoredArticlesCached(ticker);
  } catch (error) {
    console.error("Astra stored-article read failed:", error);
    return [];
  }
}

export async function fetchAnalysisDoc(
  ticker: string
): Promise<AnalysisDoc | null> {
  if (!hasAstra) return null;
  try {
    return await readAnalysisDocCached(ticker);
  } catch (error) {
    console.error("Astra analysis-doc read failed:", error);
    return null;
  }
}

function toVerdict(doc: AnalysisDoc | null): NewsVerdict | undefined {
  if (doc?.analysis_status && doc.analysis_status !== "complete") return undefined;
  if (!doc?.overall_sentiment || !doc.summary?.trim()) return undefined;
  return {
    overallSentiment: doc.overall_sentiment,
    sentimentScore:
      typeof doc.sentiment_score === "number" ? doc.sentiment_score : 0,
    confidence: doc.confidence,
    summary: doc.summary.trim(),
    keyDrivers: (doc.key_drivers ?? [])
      .filter((driver) => driver.text?.trim())
      .map((driver) => ({
        text: driver.text.trim(),
        sentiment: driver.sentiment,
      })),
    risks: (doc.risks ?? []).map((risk) => risk.trim()).filter(Boolean),
    analyzedAt: doc.analyzed_at,
    articleCount: doc.article_count,
    sourceWindowDays: doc.source_window_days,
  };
}

function conclusionTime(doc: AnalysisDoc | null): string | undefined {
  return (
    doc?.concluded_at ??
    doc?.last_success_at ??
    doc?.analyzed_at ??
    doc?.news_checked_at
  );
}

export function buildNewsSummary(
  articles: News[],
  analysisDoc: AnalysisDoc | null,
  priorityStarted: boolean,
  now: number = Date.now()
): NewsSummary {
  const concludedAt = conclusionTime(analysisDoc);
  if (analysisDoc?.analysis_status === "no_news") {
    const state = classifyMarketIntelligence({
      hasUsableContent: true,
      concludedAt,
      newsCheckedAt: analysisDoc.news_checked_at,
      lastErrorCode: analysisDoc.last_error_code,
      now,
    });
    return summarizeNews(
      [],
      state === "hard_expired"
        ? "hard_expired"
        : state === "degraded"
          ? "degraded"
          : state === "fresh"
            ? "fresh"
            : "stale",
      concludedAt
    );
  }
  if (articles.length === 0) {
    return summarizeNews([], priorityStarted ? "analyzing" : "unavailable");
  }

  const analyzedAt = analysisDoc?.analyzed_at;
  const updatedAt =
    concludedAt ?? analysisDoc?.news_loaded_at ?? latestNewsTimestamp(articles);
  const recent = windowNews(articles, POPULARITY_WINDOW_DAYS, now);
  const verdict = toVerdict(analysisDoc);
  const state = classifyMarketIntelligence({
    hasUsableContent: true,
    concludedAt,
    newsCheckedAt: analysisDoc?.news_checked_at,
    analysisFingerprint: analysisDoc?.analysis_fingerprint,
    expectedAnalysisFingerprint: expectedAnalysisFingerprint(analysisDoc),
    lastErrorCode: analysisDoc?.last_error_code,
    now,
  });
  if (state === "hard_expired") {
    return summarizeNews([], "hard_expired", updatedAt);
  }
  const status =
    analysisDoc?.analysis_status === "unavailable"
      ? "analysis_unavailable"
      : state === "degraded"
        ? "degraded"
        : state === "fresh"
          ? "fresh"
          : analyzedAt
            ? "stale"
            : "live";
  return { ...summarizeNews(recent, status, updatedAt), verdict };
}

export function buildPopularityData(
  ticker: string,
  articles: News[],
  latestVolume?: number | null
): PopularityData {
  if (!hasAnyLiveSource) {
    const mock = generateMockPopularity(ticker);
    return {
      popularityRate: mock.popularityRate,
      searchVolume: mock.searchVolume,
      series: mock.series,
      status: "sample",
    };
  }
  const searchVolume =
    typeof latestVolume === "number" && latestVolume > 0 ? latestVolume : 0;
  const deduped = dedupeNews(articles);
  return {
    popularityRate: computePopularityScore(deduped),
    searchVolume,
    series: buildPopularitySeries(deduped),
    status: "live",
  };
}

export function classifyDetailsIntelligence(
  analysisDoc: AnalysisDoc | null,
  hasUsableContent: boolean
) {
  const state = classifyMarketIntelligence({
    hasUsableContent,
    concludedAt: conclusionTime(analysisDoc),
    newsCheckedAt: analysisDoc?.news_checked_at,
    analysisFingerprint: analysisDoc?.analysis_fingerprint,
    expectedAnalysisFingerprint: expectedAnalysisFingerprint(analysisDoc),
    lastErrorCode: analysisDoc?.last_error_code,
  });
  return analysisDoc?.analysis_status === "no_news" && state === "fresh"
    ? "no_news"
    : state;
}

export function analysisConclusionTime(
  analysisDoc: AnalysisDoc | null
): string | undefined {
  return conclusionTime(analysisDoc);
}

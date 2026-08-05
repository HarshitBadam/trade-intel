import "server-only";

import type {
  StockData,
  TickerIntelligenceBundle,
} from "@/lib/market-intelligence/types";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockNews,
  generateMockPopularity,
} from "@/data/fallbacks";
import {
  GROQ_ANALYSIS_MODEL,
  hasAstra,
  hasAlpaca,
  hasFinnhub,
  hasPolygon,
} from "@/lib/config";
import { classifyMarketIntelligence } from "@/lib/market-intelligence/freshness";
import { createAnalysisFingerprint } from "@/lib/market-intelligence/fingerprints";
import {
  ANALYSIS_PROMPT_VERSION,
  applyPublishedArticleLabels,
  legacyFallbackAllowed,
} from "@/lib/market-intelligence/repository";
import type { News } from "@/components/news/RecentInfluential";
import type { NewsVerdict } from "@/components/news/VerdictModal";
import type {
  AnalysisDoc,
  BarPoint,
  NewsSummary,
  PopularityData,
  StoredArticle,
} from "./types";
import {
  buildPopularitySeries,
  computePopularityScore,
  dedupeNews,
  latestNewsTimestamp,
  mockNewsSummary,
  POPULARITY_WINDOW_DAYS,
  sanitizeTicker,
  summarizeNews,
  windowNews,
} from "./transforms";

const hasPrices = hasAlpaca || hasPolygon;
const hasAnyLive = hasAlpaca || hasPolygon || hasFinnhub || hasAstra;
const hasNewsSource = hasAstra;
import {
  getCandlesCached,
  getIntradayCached,
  getFineCached,
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getTickerDetailCached,
  readStoredArticlesCached,
  readStoredArticlesByIdsCached,
  readAnalysisDocCached,
} from "./cache";

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

export type PriorityTrigger = (ticker: string) => Promise<boolean>;

export type CandleData = {
  chart_data: BarPoint[];
  stock_price: number;
  price_change: number;
  percent_change: number;
  latest_volume?: number | null;
};

export async function getStockCandles(ticker: string): Promise<CandleData | null> {
  if (!hasPrices) return generateMockStockData(ticker);
  try {
    return await getCandlesCached(ticker);
  } catch (error) {
    console.error("Candles fetch failed:", error);
    return null;
  }
}

export async function getIntraday(ticker: string): Promise<BarPoint[]> {
  if (!hasPrices) return generateMockIntraday(ticker);
  try {
    const cached = await getIntradayCached(ticker);
    if (cached && cached.length >= 2) return cached;
  } catch (error) {
    console.error("Intraday fetch failed:", error);
  }
  return [];
}

// 1W is a pure slice of the fine (15-min, ~96-day) series, same resolution,
// same source, so it costs zero extra requests.
const WEEK_SLICE_DAYS = 8;

export function sliceRecentDays(series: BarPoint[], days: number): BarPoint[] {
  if (series.length < 2) return series;
  const latest = Date.parse(series[series.length - 1].date);
  const cutoff = latest - days * 24 * 60 * 60 * 1000;
  const recent = series.filter((p) => Date.parse(p.date) >= cutoff);
  return recent.length >= 2 ? recent : series;
}

export function weekFromFine(fine: BarPoint[]): BarPoint[] {
  return fine.length >= 2 ? sliceRecentDays(fine, WEEK_SLICE_DAYS) : [];
}

export async function getWeek(ticker: string): Promise<BarPoint[]> {
  if (!hasPrices) return generateMockWeek(ticker);
  return weekFromFine(await getFine(ticker));
}

export async function getFine(ticker: string): Promise<BarPoint[]> {
  if (!hasPrices) return generateMockFine(ticker);
  try {
    const cached = await getFineCached(ticker);
    if (cached && cached.length >= 2) return cached;
  } catch (error) {
    console.error("Fine (15m) fetch failed:", error);
  }
  return [];
}

async function fetchStoredArticles(
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
    // No manifest yet: the legacy unscoped read is only legal while no
    // refresh is staging unpublished rows for this never-before-published
    // ticker (see `legacyFallbackAllowed`). Fail closed rather than risk a
    // staged row leaking into the details page.
    if (!legacyFallbackAllowed(analysisDoc)) return [];
    return await readStoredArticlesCached(ticker);
  } catch (error) {
    console.error("Astra stored-article read failed:", error);
    return [];
  }
}

async function fetchAnalysisDoc(ticker: string): Promise<AnalysisDoc | null> {
  if (!hasAstra) return null;
  try {
    return await readAnalysisDocCached(ticker);
  } catch (error) {
    console.error("Astra analysis-doc read failed:", error);
    return null;
  }
}

// Legacy and partial docs may lack verdict fields; drivers omit article IDs because
// the details UI renders them as plain text.
function toVerdict(doc: AnalysisDoc | null): NewsVerdict | undefined {
  if (doc?.analysis_status && doc.analysis_status !== "complete") return undefined;
  if (!doc?.overall_sentiment || !doc.summary?.trim()) return undefined;
  return {
    overallSentiment: doc.overall_sentiment,
    sentimentScore: typeof doc.sentiment_score === "number" ? doc.sentiment_score : 0,
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

export function buildNewsSummary(
  articles: News[],
  analysisDoc: AnalysisDoc | null,
  priorityStarted: boolean,
  now: number = Date.now()
): NewsSummary {
  if (analysisDoc?.analysis_status === "no_news") {
    const state = classifyMarketIntelligence({
      hasUsableContent: true,
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
          : "no_news",
      analysisDoc.news_checked_at
    );
  }
  if (articles.length > 0) {
    const analyzedAt = analysisDoc?.analyzed_at;
    const updatedAt =
      analyzedAt ?? analysisDoc?.news_loaded_at ?? latestNewsTimestamp(articles);
    const recent = windowNews(articles, POPULARITY_WINDOW_DAYS, now);
    const verdict = toVerdict(analysisDoc);
    const state = classifyMarketIntelligence({
      hasUsableContent: true,
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
  return summarizeNews([], priorityStarted ? "analyzing" : "unavailable");
}

function buildPopularityData(
  ticker: string,
  articles: News[],
  latestVolume?: number | null
): PopularityData {
  if (!hasAnyLive) {
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

export function buildStockData(
  symbol: string,
  stock_data: CandleData | null,
  priceStatus: StockData["priceStatus"],
  intradayData: { date: string; value: number }[] | undefined,
  weekData: { date: string; value: number }[] | undefined,
  fineData: { date: string; value: number }[] | undefined,
  news: NewsSummary,
  popularity?: PopularityData,
  intelligence?: TickerIntelligenceBundle
): StockData {
  const pop: PopularityData = popularity ?? {
    ...generateMockPopularity(symbol),
    status: "sample",
  };
  return {
    id: symbol,
    companyName: symbol,
    stockPrice: stock_data?.stock_price,
    priceChange: stock_data?.price_change ?? 0,
    percentChange: stock_data?.percent_change ?? 0,
    priceStatus,
    popularityRate: pop.popularityRate,
    mentions: news.mentions,
    searchVolume: pop.searchVolume,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    popularitySeries: pop.series,
    popularityStatus: pop.status,
    chartData: stock_data?.chart_data ?? [],
    intradayData,
    weekData,
    fineData,
    news: news.news,
    newsStatus: news.status,
    newsUpdatedAt: news.updatedAt,
    newsVerdict: news.verdict,
    intelligence: intelligence ?? {
      ticker: symbol,
      generation: 0,
      state:
        news.status === "fresh"
          ? "fresh"
          : news.status === "sample"
            ? "fresh"
            : "missing",
      refreshState: "idle",
      publishedArticleIds: news.news.map((article) => article._id),
      newsCheckedAt: news.updatedAt,
    },
  };
}

export async function getDetailsData(
  ticker: string
): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      "sample",
      undefined,
      undefined,
      undefined,
      mockNewsSummary("N/A")
    );
  }

  const [stock_data, analysisDoc] = await Promise.all([
    getStockCandles(symbol),
    fetchAnalysisDoc(symbol),
  ]);
  const storedArticles = await fetchStoredArticles(symbol, analysisDoc);

  const priceStatus: StockData["priceStatus"] = !hasPrices
    ? "sample"
    : stock_data
      ? "live"
      : "unavailable";
  const latestVolume: number | null =
    stock_data && typeof stock_data.latest_volume === "number"
      ? stock_data.latest_volume
      : null;

  let news: NewsSummary;
  let popularityArticles: News[];

  if (!hasNewsSource) {
    news = summarizeNews(generateMockNews(symbol), "sample");
    popularityArticles = [];
  } else if (storedArticles.length > 0 || analysisDoc?.analysis_status === "no_news") {
    news = buildNewsSummary(storedArticles, analysisDoc, false);
    popularityArticles =
      news.status === "hard_expired" ? [] : storedArticles;
  } else {
    news = buildNewsSummary([], analysisDoc, false);
    popularityArticles = [];
  }

  const popularity = buildPopularityData(symbol, popularityArticles, latestVolume);

  const classifiedState = classifyMarketIntelligence({
    hasUsableContent:
      storedArticles.length > 0 || analysisDoc?.analysis_status === "no_news",
    newsCheckedAt: analysisDoc?.news_checked_at,
    analysisFingerprint: analysisDoc?.analysis_fingerprint,
    expectedAnalysisFingerprint: expectedAnalysisFingerprint(analysisDoc),
    lastErrorCode: analysisDoc?.last_error_code,
  });
  const intelligenceState =
    analysisDoc?.analysis_status === "no_news" && classifiedState === "fresh"
      ? "no_news"
      : classifiedState;

  return buildStockData(
    symbol,
    stock_data,
    priceStatus,
    undefined,
    undefined,
    undefined,
    news,
    popularity,
    {
      ticker: symbol,
      generation: analysisDoc?.generation ?? 0,
      state: intelligenceState,
      refreshState: "idle",
      publishedArticleIds:
        analysisDoc?.published_article_ids ?? storedArticles.map(({ _id }) => _id),
      contentFingerprint: analysisDoc?.content_fingerprint,
      analysisFingerprint: analysisDoc?.analysis_fingerprint,
      newsCheckedAt: analysisDoc?.news_checked_at,
      analyzedAt: analysisDoc?.analyzed_at,
      lastSuccessAt: analysisDoc?.last_success_at,
      analysisStatus: analysisDoc?.analysis_status,
    }
  );
}

export async function getChartRangeData(
  ticker: string,
  kind: "daily" | "intraday" | "week" | "fine"
): Promise<BarPoint[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  switch (kind) {
    case "daily": {
      const data = await getStockCandles(symbol);
      return data?.chart_data ?? [];
    }
    case "intraday":
      return getIntraday(symbol);
    case "week":
      return getWeek(symbol);
    case "fine":
      return getFine(symbol);
  }
}

export async function warmMarketCaches(): Promise<void> {
  if (!hasPrices) return;
  await Promise.allSettled([
    getGroupedDailyCached(),
    getMarketMapCached(),
    getMarketMapYearAgoCached(),
  ]);
}

export async function warmTicker(ticker: string): Promise<void> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return;
  const tasks: Promise<unknown>[] = [];
  if (hasPrices) {
    tasks.push(getStockCandles(symbol));
  }
  if (hasFinnhub || hasPolygon) {
    tasks.push(getTickerDetailCached(symbol));
  }
  if (hasAstra) {
    tasks.push(readStoredArticlesCached(symbol));
    tasks.push(readAnalysisDocCached(symbol));
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

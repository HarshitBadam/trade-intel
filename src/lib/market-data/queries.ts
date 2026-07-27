import "server-only";

import type { StockData } from "@/app/details/[id]/page";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockNews,
  generateMockPopularity,
} from "@/data/fallbacks";
import { hasAstra, hasAlpaca, hasFinnhub, hasPolygon } from "@/lib/config";
import type { News } from "@/components/news/RecentInfluential";
import type { NewsVerdict } from "@/components/news/VerdictModal";
import type { NewsSummary, PopularityData, BarPoint, AnalysisDoc, StoredArticle } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

const hasPrices = hasAlpaca || hasPolygon;
const hasAnyLive = hasAlpaca || hasPolygon || hasFinnhub || hasAstra;
const hasNewsSource = hasAstra || hasAlpaca;
import {
  sanitizeTicker,
  summarizeNews,
  mockNewsSummary,
  latestNewsTimestamp,
  windowNews,
  dedupeNews,
  buildPopularitySeries,
  computePopularityScore,
  POPULARITY_WINDOW_DAYS,
} from "./transforms";
import { ANALYSIS_TTL_DAYS } from "./analysis";
import { fetchAlpacaNews } from "./news-loaders";
import {
  getCandlesCached,
  getIntradayCached,
  getFineCached,
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getTickerDetailCached,
  readStoredArticlesCached,
  readAnalysisDocCached,
} from "./cache";

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

// 1W is a pure slice of the fine (15-min, ~96-day) series — same resolution,
// same source — so it costs zero extra requests.
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

async function fetchStoredArticles(ticker: string): Promise<StoredArticle[]> {
  if (!hasAstra) return [];
  try {
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

async function fetchColdAlpacaNews(ticker: string): Promise<News[]> {
  try {
    return await fetchAlpacaNews(ticker);
  } catch (error) {
    console.error("Alpaca cold news fetch failed:", error);
    return [];
  }
}

// The stored doc is written only on a fully successful analysis run, but the
// collection also holds legacy/partial rows (a news_loaded_at touch creates one
// before any verdict exists), so the display-critical fields are re-checked here
// rather than assumed. Article ids on key drivers are dropped: the UI renders
// drivers as plain text, and shipping them would bloat every details payload.
function toVerdict(doc: AnalysisDoc | null): NewsVerdict | undefined {
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

// Staleness is judged from analyzed_at ONLY — never from article dates.
export function buildNewsSummary(
  articles: News[],
  analysisDoc: AnalysisDoc | null,
  priorityStarted: boolean,
  now: number = Date.now()
): NewsSummary {
  if (articles.length > 0) {
    const analyzedAt = analysisDoc?.analyzed_at;
    const updatedAt =
      analyzedAt ?? analysisDoc?.news_loaded_at ?? latestNewsTimestamp(articles);
    const recent = windowNews(articles, POPULARITY_WINDOW_DAYS, now);
    const verdict = toVerdict(analysisDoc);
    if (analyzedAt) {
      const analyzedMs = Date.parse(analyzedAt);
      const fresh =
        !Number.isNaN(analyzedMs) &&
        now - analyzedMs <= ANALYSIS_TTL_DAYS * DAY_MS;
      return {
        ...summarizeNews(recent, fresh ? "fresh" : "stale", updatedAt),
        verdict,
      };
    }
    return { ...summarizeNews(recent, "live", updatedAt), verdict };
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
  popularity?: PopularityData
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
  };
}

export async function getDetailsData(
  ticker: string,
  triggerPriority?: PriorityTrigger
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

  const [stock_data, storedArticles, analysisDoc] = await Promise.all([
    getStockCandles(symbol),
    fetchStoredArticles(symbol),
    fetchAnalysisDoc(symbol),
  ]);

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
  } else if (storedArticles.length > 0) {
    news = buildNewsSummary(storedArticles, analysisDoc, false);
    popularityArticles = storedArticles;
  } else {
    const alpaca = hasAlpaca ? await fetchColdAlpacaNews(symbol) : [];
    const priorityStarted = triggerPriority ? await triggerPriority(symbol) : false;
    news = buildNewsSummary(alpaca, null, priorityStarted);
    popularityArticles = alpaca;
  }

  const popularity = buildPopularityData(symbol, popularityArticles, latestVolume);

  return buildStockData(
    symbol,
    stock_data,
    priceStatus,
    undefined,
    undefined,
    undefined,
    news,
    popularity
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

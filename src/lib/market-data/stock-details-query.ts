import "server-only";

import type { News } from "@/components/news/RecentInfluential";
import {
  generateMockNews,
  generateMockPopularity,
  generateMockStockData,
} from "@/data/fallbacks";
import { hasAstra } from "@/lib/config";
import type {
  StockData,
  TickerIntelligenceBundle,
} from "@/lib/market-intelligence/types";
import {
  analysisConclusionTime,
  buildNewsSummary,
  buildPopularityData,
  classifyDetailsIntelligence,
  fetchAnalysisDoc,
  fetchStoredArticles,
} from "./news-queries";
import {
  getStockCandles,
  hasLivePrices,
  type CandleData,
} from "./price-queries";
import { mockNewsSummary, sanitizeTicker, summarizeNews } from "./transforms";
import type { NewsSummary, PopularityData } from "./types";

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

export async function getDetailsData(ticker: string): Promise<StockData> {
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

  const [stockData, analysisDoc] = await Promise.all([
    getStockCandles(symbol),
    fetchAnalysisDoc(symbol),
  ]);
  const storedArticles = await fetchStoredArticles(symbol, analysisDoc);
  const priceStatus: StockData["priceStatus"] = !hasLivePrices
    ? "sample"
    : stockData
      ? "live"
      : "unavailable";
  const latestVolume =
    stockData && typeof stockData.latest_volume === "number"
      ? stockData.latest_volume
      : null;

  let news: NewsSummary;
  let popularityArticles: News[];
  if (!hasAstra) {
    news = summarizeNews(generateMockNews(symbol), "sample");
    popularityArticles = [];
  } else if (
    storedArticles.length > 0 ||
    analysisDoc?.analysis_status === "no_news"
  ) {
    news = buildNewsSummary(storedArticles, analysisDoc, false);
    popularityArticles = news.status === "hard_expired" ? [] : storedArticles;
  } else {
    news = buildNewsSummary([], analysisDoc, false);
    popularityArticles = [];
  }

  return buildStockData(
    symbol,
    stockData,
    priceStatus,
    undefined,
    undefined,
    undefined,
    news,
    buildPopularityData(symbol, popularityArticles, latestVolume),
    {
      ticker: symbol,
      generation: analysisDoc?.generation ?? 0,
      state: classifyDetailsIntelligence(
        analysisDoc,
        storedArticles.length > 0 || analysisDoc?.analysis_status === "no_news"
      ),
      refreshState: "idle",
      publishedArticleIds:
        analysisDoc?.published_article_ids ??
        storedArticles.map(({ _id }) => _id),
      contentFingerprint: analysisDoc?.content_fingerprint,
      analysisFingerprint: analysisDoc?.analysis_fingerprint,
      newsCheckedAt: analysisDoc?.news_checked_at,
      concludedAt: analysisConclusionTime(analysisDoc),
      analyzedAt: analysisDoc?.analyzed_at,
      lastSuccessAt: analysisDoc?.last_success_at,
      analysisStatus: analysisDoc?.analysis_status,
    }
  );
}

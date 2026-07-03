import "server-only";

import { after } from "next/server";
import type { StockData } from "@/app/details/[id]/page";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockNews,
  generateMockPopularity,
} from "@/data/fallbacks";
import { hasAstra, hasPolygon, hasLangflowIngest } from "@/lib/config";
import { ingestTickerNews } from "@/lib/news-ingest";
import type { NewsSummary } from "./types";
import { sanitizeTicker, summarizeNews, mockNewsSummary, latestNewsTimestamp } from "./transforms";
import {
  getCandlesCached,
  getIntradayCached,
  getWeekCached,
  getFineCached,
  getNewsCached,
  getPolygonNewsCached,
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getTickerDetailCached,
} from "./cache";

export async function getStockCandles(ticker: string) {
  if (hasPolygon) {
    try {
      const cached = await getCandlesCached(ticker);
      if (cached) return cached;
    } catch (error) {
      console.error("Polygon candles fetch failed, using fallback:", error);
    }
  }
  return generateMockStockData(ticker);
}

export async function getIntraday(ticker: string): Promise<{ date: string; value: number }[]> {
  if (hasPolygon) {
    try {
      const cached = await getIntradayCached(ticker);
      if (cached && cached.length >= 2) return cached;
    } catch (error) {
      console.error("Polygon intraday fetch failed, using fallback:", error);
    }
  }
  return generateMockIntraday(ticker);
}

export async function getWeek(ticker: string): Promise<{ date: string; value: number }[]> {
  if (hasPolygon) {
    try {
      const cached = await getWeekCached(ticker);
      if (cached && cached.length >= 2) return cached;
    } catch (error) {
      console.error("Polygon 15m fetch failed, using fallback:", error);
    }
  }
  return generateMockWeek(ticker);
}

export async function getFine(ticker: string): Promise<{ date: string; value: number }[]> {
  if (hasPolygon) {
    try {
      const cached = await getFineCached(ticker);
      if (cached && cached.length >= 2) return cached;
    } catch (error) {
      console.error("Polygon 1h fetch failed, using fallback:", error);
    }
  }
  return generateMockFine(ticker);
}

export async function getNews(ticker: string): Promise<NewsSummary> {
  let analyzing = false;

  if (hasAstra) {
    try {
      const news = await getNewsCached(ticker);
      if (news.length > 0) {
        return summarizeNews(news, "fresh", latestNewsTimestamp(news));
      }
      analyzing = scheduleNewsIngestion(ticker);
    } catch (error) {
      console.error("Astra DB news fetch failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    try {
      const news = await getPolygonNewsCached(ticker);
      if (news.length > 0) {
        return summarizeNews(news, analyzing ? "analyzing" : "live");
      }
    } catch (error) {
      console.error("Polygon news fetch failed, using fallback:", error);
    }
  }
  return summarizeNews(
    generateMockNews(ticker),
    analyzing ? "analyzing" : "sample"
  );
}

export function scheduleNewsIngestion(ticker: string): boolean {
  if (!hasLangflowIngest) return false;
  after(() => ingestTickerNews(ticker));
  return true;
}

export function buildStockData(
  symbol: string,
  stock_data: ReturnType<typeof generateMockStockData>,
  intradayData: { date: string; value: number }[] | undefined,
  weekData: { date: string; value: number }[] | undefined,
  fineData: { date: string; value: number }[] | undefined,
  news: NewsSummary
): StockData {
  const pop = generateMockPopularity(symbol);
  return {
    id: symbol,
    companyName: symbol,
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    popularityRate: pop.popularityRate,
    mentions: news.mentions,
    searchVolume: pop.searchVolume,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    chartData: stock_data.chart_data,
    intradayData,
    weekData,
    fineData,
    news: news.news,
    newsStatus: news.status,
    newsUpdatedAt: news.updatedAt,
  };
}

export async function getDetailsData(ticker: string): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      undefined,
      undefined,
      undefined,
      mockNewsSummary("N/A")
    );
  }

  const [stock_data, news] = await Promise.all([
    getStockCandles(symbol),
    getNews(symbol),
  ]);

  return buildStockData(symbol, stock_data, undefined, undefined, undefined, news);
}

export async function getChartRangeData(
  ticker: string,
  kind: "daily" | "intraday" | "week" | "fine"
): Promise<{ date: string; value: number }[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  switch (kind) {
    case "daily": {
      const data = await getStockCandles(symbol);
      return data.chart_data;
    }
    case "intraday":
      return getIntraday(symbol);
    case "week":
      return getWeek(symbol);
    case "fine":
      return getFine(symbol);
  }
}

// Best-effort cache warming for cron — pure reads only, no ingestion side effects.
export async function warmMarketCaches(): Promise<void> {
  if (!hasPolygon) return;
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
  if (hasPolygon) {
    tasks.push(getStockCandles(symbol), getTickerDetailCached(symbol));
  }
  // Warm the Astra READ cache only (no ingestion side effect).
  if (hasAstra) {
    tasks.push(getNewsCached(symbol));
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

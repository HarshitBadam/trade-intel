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
import { claimIngestSlot, ingestTickerNews } from "@/lib/news-ingest";
import type { News } from "@/components/news/RecentInfluential";
import type { NewsSummary, PopularityData } from "./types";
import {
  sanitizeTicker,
  summarizeNews,
  mockNewsSummary,
  latestNewsTimestamp,
  isNewsStale,
  windowNews,
  dedupeNews,
  buildPopularitySeries,
  computePopularityScore,
} from "./transforms";
import {
  getCandlesCached,
  getIntradayCached,
  getWeekCached,
  getFineCached,
  getNewsCached,
  getPolygonNewsCached,
  getPopularityNewsCached,
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
      console.error("Polygon fine (15m) fetch failed, using fallback:", error);
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
        // Freshness is about the newest article overall, so derive updatedAt /
        // staleness from the FULL all-time set BEFORE windowing — a ticker whose
        // latest story is (say) 17 days old must still report that timestamp and
        // stale badge even though the gauge below only counts the last 90 days.
        const updatedAt = latestNewsTimestamp(news);
        const stale = isNewsStale(updatedAt);
        // Align the gauge (positive/negative %) and Mentions with the popularity
        // score/chart by summarizing only the last POPULARITY_WINDOW_DAYS, so the
        // two stop measuring different time populations of the same ticker.
        const recent = windowNews(news);
        // Past the 7-day TTL: keep serving the existing analysis but kick off a
        // background re-ingest and mark it "analyzing" so the client polls the
        // refreshed version in (stale-while-revalidate). If ingestion isn't
        // configured or the ticker is in an ingest cooldown (6h after success,
        // 10min after a failed attempt), no job runs — so we honestly label the
        // data "stale" rather than pretending it's "fresh".
        if (stale) {
          const refreshing = await scheduleNewsIngestion(ticker);
          return summarizeNews(
            recent,
            refreshing ? "analyzing" : "stale",
            updatedAt
          );
        }
        return summarizeNews(recent, "fresh", updatedAt);
      }
      analyzing = await scheduleNewsIngestion(ticker);
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

export async function scheduleNewsIngestion(ticker: string): Promise<boolean> {
  if (!hasLangflowIngest) return false;
  // Claim the ingest slot BEFORE reporting "analyzing". Otherwise every visit
  // within a cooldown claims an analysis is running when the ingest job would
  // instantly bail on the rate limit, and the UI's "Updating..." promise is
  // broken.
  if (!(await claimIngestSlot(ticker))) return false;
  after(() => ingestTickerNews(ticker, { skipRateLimit: true }));
  return true;
}

// Builds the popularity/social card entirely from real sources when available:
// the trend from dated, sentiment-tagged news (Astra's accumulated docs unioned
// with a wide Polygon pull) and the volume stat from Polygon daily aggregates.
// The latest daily volume is passed in (derived from the candles the caller
// already fetched) rather than fetched here, so the popularity view adds no
// extra Polygon request. Falls back to the deterministic mock (status "sample")
// only in open demo mode where no provider is configured — which is exactly
// when the "Illustrative" badge should still show.
export async function getPopularity(
  ticker: string,
  latestVolume?: number | null
): Promise<PopularityData> {
  const articles: News[] = [];
  let live = false;

  if (hasAstra) {
    try {
      const astraNews = await getNewsCached(ticker);
      if (astraNews.length > 0) {
        articles.push(...astraNews);
        live = true;
      }
    } catch (error) {
      console.error("Astra popularity news fetch failed:", error);
    }
  }

  if (hasPolygon) {
    try {
      const polygonNews = await getPopularityNewsCached(ticker);
      if (polygonNews.length > 0) {
        articles.push(...polygonNews);
        live = true;
      }
    } catch (error) {
      console.error("Polygon popularity news fetch failed:", error);
    }
  }

  let searchVolume = 0;
  if (typeof latestVolume === "number" && latestVolume > 0) {
    searchVolume = latestVolume;
    live = true;
  }

  if (!live) {
    const mock = generateMockPopularity(ticker);
    return {
      popularityRate: mock.popularityRate,
      searchVolume: mock.searchVolume,
      series: mock.series,
      status: "sample",
    };
  }

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
  stock_data: ReturnType<typeof generateMockStockData>,
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
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    popularityRate: pop.popularityRate,
    mentions: news.mentions,
    searchVolume: pop.searchVolume,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    popularitySeries: pop.series,
    popularityStatus: pop.status,
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

  // Resolve candles first so the latest daily volume can seed the popularity
  // card without a second Polygon round-trip. Fetching it before (rather than
  // alongside) news also staggers the Polygon calls, easing the free tier's
  // ~5 req/min ceiling.
  const stock_data = await getStockCandles(symbol);
  const latestVolume: number | null =
    "latest_volume" in stock_data &&
    typeof stock_data.latest_volume === "number"
      ? stock_data.latest_volume
      : null;

  const [news, popularity] = await Promise.all([
    getNews(symbol),
    getPopularity(symbol, latestVolume),
  ]);

  return buildStockData(
    symbol,
    stock_data,
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

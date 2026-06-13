"use server";

import { unstable_cache } from "next/cache";
import { News } from "@/components/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { StockData } from "./page";
import {
  generateMockNews,
  generateMockStockData,
  searchFallbackTickers,
} from "@/data/fallbacks";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
  hasAstra,
  hasPolygon,
  POLYGON_API_KEY,
} from "@/lib/config";
import { guard } from "@/lib/guard";

export type SearchResult = {
  ticker: string;
  name: string;
};

// A ticker is 1-5 letters; reject anything else before it reaches an API.
function sanitizeTicker(input: string): string {
  return (input ?? "").toString().toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 6);
}

export async function searchStocks(query: string): Promise<SearchResult[]> {
  const cleaned = (query ?? "").toString().slice(0, 64).trim();
  if (!cleaned) return [];

  // Search hits Polygon's reference API; rate-limit it. Fall back to local
  // results (no spend) on auth failure or throttle rather than erroring.
  const access = await guard("search", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return searchFallbackTickers(cleaned);
  }

  if (hasPolygon) {
    try {
      // Key goes in the Authorization header (not the URL) so it can't leak via
      // request logs, proxies or error traces.
      const url = `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(
        cleaned
      )}&market=stocks&active=true&limit=5`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      });
      const data = await response.json();

      if (data.results?.length) {
        return data.results.map((stock: { ticker: string; name?: string }) => ({
          ticker: stock.ticker,
          name: stock.name ?? stock.ticker,
        }));
      }
    } catch (error) {
      console.error(
        "Polygon ticker search failed, using fallback:",
        error instanceof Error ? error.message : "unknown error"
      );
    }
  }

  return searchFallbackTickers(cleaned);
}

export async function fetchDetails(ticker: string): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData("N/A", generateMockStockData("N/A"), mockNewsSummary("N/A"));
  }

  // On auth failure / throttle, serve deterministic mock data (zero API spend).
  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return buildStockData(
      symbol,
      generateMockStockData(symbol),
      mockNewsSummary(symbol)
    );
  }

  const [stock_data, news] = await Promise.all([
    getStockCandles(symbol),
    getNews(symbol),
  ]);

  return buildStockData(symbol, stock_data, news);
}

function buildStockData(
  symbol: string,
  stock_data: ReturnType<typeof generateMockStockData>,
  news: NewsSummary
): StockData {
  return {
    id: symbol,
    companyName: symbol,
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    popularityRate: 92,
    mentions: news.mentions,
    searchVolume: 850000,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    chartData: stock_data.chart_data,
    news: news.news,
  };
}

type NewsSummary = {
  mentions: number;
  positiveSentiment: number;
  negativeSentiment: number;
  news: News[];
};

function summarizeNews(news: News[]): NewsSummary {
  const mentions = news.length;
  const pct = (sentiment: string) =>
    mentions === 0
      ? 0
      : Math.round(
          (news.filter((n) => n.metadata.sentiment === sentiment).length /
            mentions) *
            100
        );
  return {
    mentions,
    positiveSentiment: pct("Positive"),
    negativeSentiment: pct("Negative"),
    news,
  };
}

function mockNewsSummary(ticker: string): NewsSummary {
  return summarizeNews(generateMockNews(ticker));
}

// ── Cached live fetchers ────────────────────────────────────────────────────
// Caching collapses repeated requests for the same ticker into a single
// upstream call, cutting both API spend (Polygon/Astra) and Vercel function
// time. Keyed purely by ticker so it's safe to memoize.

const getCandlesCached = unstable_cache(
  async (ticker: string) => {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // Authorization header (not URL query) to keep the key out of logs.
    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fmt(
        from
      )}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    const stock_data = await response.json();

    const results = stock_data.results as
      | { t: number; c: number; o: number }[]
      | undefined;
    if (!results || results.length < 2) return null;

    const last = results[results.length - 1];
    const prev = results[results.length - 2];
    return {
      chart_data: results.map((candle) => ({
        date: new Date(candle.t as number).toISOString(),
        value: candle.c as number,
      })),
      stock_price: last.c as number,
      price_change: (last.c as number) - (prev.c as number),
      percent_change:
        (((last.c as number) - (prev.c as number)) / (prev.c as number)) * 100,
    };
  },
  ["polygon-candles"],
  { revalidate: 300, tags: ["candles"] }
);

const getNewsCached = unstable_cache(
  async (ticker: string): Promise<News[]> => {
    const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
    const database = client.db(ASTRA_DB_API_ENDPOINT!);
    const table = database.collection<News>(ASTRA_DB_NEWS_COLLECTION);
    return table.find({ "metadata.ticker": ticker }).toArray();
  },
  ["astra-news"],
  { revalidate: 600, tags: ["news"] }
);

async function getStockCandles(ticker: string) {
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

async function getNews(ticker: string): Promise<NewsSummary> {
  if (hasAstra) {
    try {
      const news = await getNewsCached(ticker);
      if (news.length > 0) return summarizeNews(news);
    } catch (error) {
      console.error("Astra DB news fetch failed, using fallback:", error);
    }
  }
  return mockNewsSummary(ticker);
}

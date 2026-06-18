"use server";

import type { StockData } from "./page";
import {
  searchFallbackTickers,
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
} from "@/data/fallbacks";
import { hasPolygon } from "@/lib/config";
import { guard } from "@/lib/guard";
import {
  buildStockData,
  getDetailsData,
  getQuoteData,
  getHeadlineData,
  getMoversData,
  getLiveQuotes as getLiveQuotesImpl,
  getRelatedStocksData,
  getChartRangeData,
  getHomeTickerData,
  searchTickersCached,
  mockQuote,
  mockHeadline,
  mockNewsSummary,
  mockMovers,
  summarizeMovers,
  sanitizeTicker,
} from "@/lib/market-data";

import type {
  Quote,
  Headline,
  Movers,
  LiveQuote,
  RelatedCard,
  SearchResult,
} from "@/lib/market-data-types";

export async function searchStocks(query: string): Promise<SearchResult[]> {
  const cleaned = (query ?? "").toString().slice(0, 64).trim();
  if (!cleaned) return [];

  // Polygon's live search is the richest source, but its free tier allows only
  // ~5 req/min shared with every other call. searchTickersCached caches each
  // query for a day, so a given search hits the API at most once; on a 429 it
  // throws (failure isn't cached) and we drop to the local index below — which
  // is why common names still resolve instead of showing "No stocks found".
  if (hasPolygon) {
    const access = await guard("search", { limit: 60, windowSec: 60 });
    if (access.ok) {
      try {
        const live = await searchTickersCached(cleaned);
        if (live.length) return live;
      } catch {
        // rate-limited (429) or transient error → fall through to local index
      }
    }
  }

  return searchFallbackTickers(cleaned);
}

export async function fetchDetails(ticker: string): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      generateMockIntraday("N/A"),
      generateMockWeek("N/A"),
      generateMockFine("N/A"),
      mockNewsSummary("N/A")
    );
  }

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return buildStockData(
      symbol,
      generateMockStockData(symbol),
      generateMockIntraday(symbol),
      generateMockWeek(symbol),
      generateMockFine(symbol),
      mockNewsSummary(symbol)
    );
  }

  return getDetailsData(symbol);
}

export async function fetchQuote(ticker: string): Promise<Quote> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockQuote("N/A");

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return mockQuote(symbol);

  return getQuoteData(symbol);
}

export async function fetchTopHeadline(ticker: string): Promise<Headline> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockHeadline("AAPL");

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return mockHeadline(symbol);

  return getHeadlineData(symbol);
}

export async function fetchMovers(): Promise<Movers> {
  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return summarizeMovers(mockMovers());

  return getMoversData();
}

export async function getLiveQuotes(tickers: string[]): Promise<LiveQuote[]> {
  return getLiveQuotesImpl(tickers);
}

export async function fetchRelatedStocks(
  ticker: string
): Promise<RelatedCard[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return [];

  return getRelatedStocksData(symbol);
}

export async function fetchChartRange(
  ticker: string,
  kind: "daily" | "intraday" | "week" | "fine"
): Promise<{ date: string; value: number }[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    switch (kind) {
      case "daily":
        return generateMockStockData(symbol).chart_data;
      case "intraday":
        return generateMockIntraday(symbol);
      case "week":
        return generateMockWeek(symbol);
      case "fine":
        return generateMockFine(symbol);
    }
  }

  return getChartRangeData(symbol, kind);
}

export async function fetchHomeTicker(ticker: string): Promise<{
  quote: Quote;
  headline: Headline;
}> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return { quote: mockQuote("N/A"), headline: mockHeadline("N/A") };

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return { quote: mockQuote(symbol), headline: mockHeadline(symbol) };

  return getHomeTickerData(symbol);
}

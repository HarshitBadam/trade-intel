"use server";

import type { StockData } from "./page";
import {
  searchFallbackTickers,
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
} from "@/data/fallbacks";
import { hasAlpaca, hasFinnhub, hasPolygon } from "@/lib/config";
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
  BarPoint,
} from "@/lib/market-data/types";

// A live price provider (Alpaca preferred, Polygon fallback).
const hasPrices = hasAlpaca || hasPolygon;
// A provider that can enrich symbol search (Finnhub preferred, Polygon fallback).
const hasSearchProvider = hasFinnhub || hasPolygon;

function mergeSearchResults(
  local: SearchResult[],
  live: SearchResult[]
): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of [...local, ...live]) {
    const key = r.ticker.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= 8) break;
  }
  return out;
}

export async function searchStocks(query: string): Promise<SearchResult[]> {
  const cleaned = (query ?? "").toString().slice(0, 64).trim();
  if (!cleaned) return [];

  // Local static index FIRST: it covers the common names instantly with zero
  // API spend. Only reach for a provider when the local index is thin — then
  // Finnhub (preferred, 60/min) or Polygon (fallback) enriches the long tail.
  // searchTickersCached caches each query for a day; on a 429/transient error it
  // throws (failure isn't cached) and we keep the local results.
  const local = searchFallbackTickers(cleaned);
  if (local.length >= 3 || !hasSearchProvider) return local;

  const access = await guard("search", { limit: 60, windowSec: 60 });
  if (access.ok) {
    try {
      const live = await searchTickersCached(cleaned);
      if (live.length) return mergeSearchResults(local, live);
    } catch {
      // rate-limited (429) or transient error → keep the local index
    }
  }

  return local;
}

export async function fetchDetails(ticker: string): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      "sample",
      generateMockIntraday("N/A"),
      generateMockWeek("N/A"),
      generateMockFine("N/A"),
      mockNewsSummary("N/A")
    );
  }

  // A per-user rate-limited poll must NOT silently degrade to mock data — the
  // page already has real data on screen; report "unavailable" so the client
  // keeps what it has and retries later.
  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return buildStockData(
      symbol,
      null,
      "unavailable",
      undefined,
      undefined,
      undefined,
      { mentions: 0, positiveSentiment: 0, negativeSentiment: 0, news: [], status: "unavailable" }
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
): Promise<BarPoint[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    // Live mode: an empty series makes the chart keep the real daily view for
    // that range — never a fabricated hi-res series. Mocks are demo-only.
    if (hasPrices) return [];
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

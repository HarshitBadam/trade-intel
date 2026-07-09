"use server";

import type { StockData } from "./page";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
} from "@/data/fallbacks";
import { hasAlpaca, hasFinnhub, hasPolygon } from "@/lib/config";
import { guard } from "@/lib/guard";
import { triggerPriorityAnalysis } from "./priority";
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
  searchUniverse,
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
  SearchResponse,
  BarPoint,
} from "@/lib/market-data/types";

// A live price provider (Alpaca preferred, Polygon fallback).
const hasPrices = hasAlpaca || hasPolygon;

export async function searchStocks(query: string): Promise<SearchResponse> {
  const cleaned = (query ?? "").toString().slice(0, 64).trim();
  if (!cleaned) return { stocks: [] };

  // Local universe FIRST: ~12.5k committed US-listed names (built from
  // Alpaca's own asset list, so every hit is chartable by construction)
  // answer almost every query instantly, with zero API spend and zero keys.
  // Any local hit ends the search — the live fallback exists only for the
  // out-of-universe long tail, where Finnhub's fuzzy /search adds reach.
  const local = searchUniverse(cleaned);
  if (local.length > 0 || !hasFinnhub) {
    return { stocks: local.map((e) => ({ ticker: e.symbol, name: e.name })) };
  }

  const access = await guard("search", { limit: 60, windowSec: 60 });
  if (!access.ok) {
    // Over the per-user limit with nothing local to show: report the search
    // as unavailable rather than pretending the query matched nothing.
    return { stocks: [], searchUnavailable: true };
  }
  try {
    const live = await searchTickersCached(cleaned);
    return { stocks: live };
  } catch (error) {
    console.error(`[search] live fallback failed for "${cleaned}":`, error);
    return { stocks: [], searchUnavailable: true };
  }
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

  return getDetailsData(symbol, triggerPriorityAnalysis);
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

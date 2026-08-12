"use server";

import type { StockData } from "./page";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
} from "@/data/fallbacks";
import {
  hasAlpaca,
  hasFinnhub,
  hasPolygon,
  MARKET_INTELLIGENCE_USER_BURST_LIMIT,
  MARKET_INTELLIGENCE_USER_DAILY_LIMIT,
} from "@/lib/config";
import { guard } from "@/lib/guard";
import {
  getTickerRefreshStatus,
  requestTickerRefresh,
} from "@/lib/market-intelligence/queue";
import type { RefreshJob } from "@/lib/market-intelligence/job-store";
import {
  buildStockData,
  getDetailsData,
  getChartRangeData,
} from "@/lib/market-data/queries";
import {
  getQuoteData,
  getHeadlineData,
  getMoversData,
  getHomeTickerData,
  getLiveQuotes as getLiveQuotesImpl,
} from "@/lib/market-data/api-home";
import { searchTickersCached } from "@/lib/market-data/cache";
import { searchUniverse } from "@/lib/market-data/universe";
import {
  mockQuote,
  mockHeadline,
  mockNewsSummary,
  mockMovers,
  summarizeMovers,
  sanitizeTicker,
} from "@/lib/market-data/transforms";

import type {
  Quote,
  Headline,
  Movers,
  LiveQuote,
  SearchResponse,
  BarPoint,
} from "@/lib/market-data/types";

const hasPrices = hasAlpaca || hasPolygon;

export async function searchStocks(query: string): Promise<SearchResponse> {
  const cleaned = (query ?? "").toString().slice(0, 64).trim();
  if (!cleaned) return { stocks: [] };

  const local = searchUniverse(cleaned);
  if (local.length > 0 || !hasFinnhub) {
    return { stocks: local.map((e) => ({ ticker: e.symbol, name: e.name })) };
  }

  const access = await guard("search", { limit: 60, windowSec: 60 });
  if (!access.ok) {
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

export async function fetchDetails(ticker: string): Promise<StockData | null> {
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

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return null;

  return getDetailsData(symbol);
}

export type RefreshActionResult =
  | { ok: true; job: RefreshJob; joined: boolean }
  | { ok: false; reason: "invalid" | "unavailable" | "rate_limited"; retryAfterSec?: number };

export async function requestDetailsRefresh(
  ticker: string
): Promise<RefreshActionResult> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return { ok: false, reason: "invalid" };
  const burst = await guard("ticker-refresh", {
    limit: MARKET_INTELLIGENCE_USER_BURST_LIMIT,
    windowSec: 60,
  });
  if (!burst.ok) {
    return {
      ok: false,
      reason: burst.reason === "rate_limited" ? "rate_limited" : "unavailable",
      retryAfterSec: burst.retryAfterSec,
    };
  }
  const daily = await guard("ticker-refresh-daily", {
    limit: MARKET_INTELLIGENCE_USER_DAILY_LIMIT,
    windowSec: 24 * 60 * 60,
  });
  if (!daily.ok) {
    return {
      ok: false,
      reason: daily.reason === "rate_limited" ? "rate_limited" : "unavailable",
      retryAfterSec: daily.retryAfterSec,
    };
  }
  try {
    const result = await requestTickerRefresh(symbol, "user_request");
    return { ok: true, job: result, joined: result.joined };
  } catch {
    return { ok: false, reason: "unavailable", retryAfterSec: 60 };
  }
}

export async function pollDetailsRefresh(
  workId: string
): Promise<RefreshJob | null> {
  const access = await guard("ticker-refresh-poll", {
    limit: 120,
    windowSec: 60,
  });
  if (!access.ok) return null;
  return getTickerRefreshStatus(workId);
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
  if (!access.ok) return summarizeMovers(mockMovers(), "sample");

  return getMoversData();
}

export async function getLiveQuotes(tickers: string[]): Promise<LiveQuote[]> {
  return getLiveQuotesImpl(tickers);
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
    // that range, never a fabricated hi-res series. Mocks are demo-only.
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

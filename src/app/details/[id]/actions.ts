"use server";

import { after } from "next/server";
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
  warmChartable,
  getChartableTickersFast,
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
    if (out.length >= 10) break;
  }
  return out;
}

// Speculatively starts the background chartability check (see
// checkSearchChartable/getChartableTickersFast) for a search result BEFORE
// returning it. Runs inside `after()`, i.e. after this response is already on
// its way to the client — so the ~790ms Alpaca round-trip overlaps with that
// network hop and the client's own follow-up request, instead of only
// starting once that follow-up arrives.
function warmChartableOnReturn(results: SearchResult[]): SearchResult[] {
  if (results.length > 0) {
    after(() => warmChartable(results.map((r) => r.ticker)));
  }
  return results;
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
  if (local.length >= 3 || !hasSearchProvider) return warmChartableOnReturn(local);

  const access = await guard("search", { limit: 60, windowSec: 60 });
  if (access.ok) {
    try {
      const live = await searchTickersCached(cleaned);
      if (live.length) return warmChartableOnReturn(mergeSearchResults(local, live));
    } catch {
      // rate-limited (429) or transient error → keep the local index
    }
  }

  return warmChartableOnReturn(local);
}

// Second, background pass for the search dropdown: verifies which of the
// results already shown can actually be charted, so the UI can quietly mark
// the rare dead end unavailable (see getChartableTickers) instead of gating
// the whole dropdown on this ~3x-slower-than-search round-trip. Fails open on
// a rate limit — an occasional missed check just means a stale entry lingers,
// which beats hiding valid results.
export async function checkSearchChartable(tickers: string[]): Promise<string[]> {
  const clean = tickers.map(sanitizeTicker).filter(Boolean);
  if (clean.length === 0) return [];

  // Guard (an Upstash round-trip, ~60-270ms measured) and the chartability
  // fetch (an Alpaca round-trip, ~790ms measured — likely already warming
  // since searchStocks, see warmChartableOnReturn) run IN PARALLEL rather than
  // one gating the other. This is safe specifically because it's a
  // best-effort background check, not a gate on a scarce/paid budget: Alpaca's
  // 180/min budget comfortably absorbs an occasional over-limit user's check,
  // unlike Polygon's precious 5/min. There's no correctness reason to pay the
  // guard's latency before starting the (already slower) Alpaca one.
  const [access, chartable] = await Promise.all([
    guard("search", { limit: 60, windowSec: 60 }),
    getChartableTickersFast(clean),
  ]);
  return access.ok ? chartable : clean;
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

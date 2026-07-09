import {
  FALLBACK_TICKERS,
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockPopularity,
} from "@/data/fallbacks";
import type { Quote, Mover, Movers, BarPoint, LiveQuote } from "./types";
import type { AlpacaBar, AlpacaSnapshot } from "./alpaca";

export function sanitizeTicker(input: string): string {
  return (input ?? "").toString().toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 6);
}

export function mockQuote(symbol: string): Quote {
  const s = generateMockStockData(symbol);
  return {
    ticker: symbol,
    stockPrice: s.stock_price,
    priceChange: s.price_change,
    percentChange: s.percent_change,
    chartData: s.chart_data,
    intradayData: generateMockIntraday(symbol),
    weekData: generateMockWeek(symbol),
    fineData: generateMockFine(symbol),
  };
}

export function mapAlpacaBars(bars: AlpacaBar[]): BarPoint[] {
  return bars
    .map((b) => ({
      date: new Date(b.t).toISOString(),
      value: b.c,
      volume: typeof b.v === "number" ? b.v : undefined,
      trades: typeof b.n === "number" ? b.n : undefined,
    }))
    .filter((p) => Number.isFinite(p.value) && !Number.isNaN(Date.parse(p.date)));
}

export type PolygonAggBar = {
  t: number;
  c: number;
  o?: number;
  v?: number;
  n?: number;
};

export function mapPolygonAggs(results: PolygonAggBar[]): BarPoint[] {
  return results
    .map((b) => ({
      date: new Date(b.t).toISOString(),
      value: b.c,
      volume: typeof b.v === "number" ? b.v : undefined,
      trades: typeof b.n === "number" ? b.n : undefined,
    }))
    .filter((p) => Number.isFinite(p.value) && !Number.isNaN(Date.parse(p.date)));
}

// Derives a live quote from an Alpaca snapshot. Price is the latest trade (or
// today's close); day change is measured against the previous daily close.
// Returns null when the essentials are missing so a card never renders an invented price.
export function mapAlpacaSnapshotQuote(
  ticker: string,
  snap: AlpacaSnapshot | undefined
): LiveQuote | null {
  if (!snap) return null;
  const price = snap.latestTrade?.p ?? snap.dailyBar?.c;
  const prevClose = snap.prevDailyBar?.c;
  if (typeof price !== "number" || price <= 0) return null;
  if (typeof prevClose !== "number" || prevClose <= 0) return null;
  const change = price - prevClose;
  return {
    ticker,
    price,
    change,
    percentChange: (change / prevClose) * 100,
    volume: typeof snap.dailyBar?.v === "number" ? snap.dailyBar.v : 0,
  };
}

export function mockMovers(): Mover[] {
  return FALLBACK_TICKERS.map(({ ticker, name }) => {
    const s = generateMockStockData(ticker);
    return {
      ticker,
      name,
      price: s.stock_price,
      change: s.price_change,
      percentChange: s.percent_change,
      volume: generateMockPopularity(ticker).searchVolume,
    };
  });
}

export function summarizeMovers(all: Mover[]): Movers {
  const byPct = [...all].sort((a, b) => b.percentChange - a.percentChange);
  const byAbs = [...all].sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
  const byVolume = [...all].sort((a, b) => b.volume - a.volume);
  return {
    gainers: byPct.slice(0, 3),
    losers: byPct.slice(-3).reverse(),
    shifts: byAbs.slice(0, 3),
    mostActive: byVolume.slice(0, 3),
  };
}

export {
  newsToHeadline,
  pickTopArticle,
  mockHeadline,
  normalizeSentiment,
  mapPolygonNews,
  summarizeNews,
  mockNewsSummary,
  latestNewsTimestamp,
  windowNews,
  dedupeNews,
  buildPopularitySeries,
  computePopularityScore,
  POPULARITY_WINDOW_DAYS,
  type PolygonNewsResult,
} from "./transforms-news";

export { buildActivitySeries } from "./transforms-activity";

export {
  titleCase,
  formatMarketCap,
  fmtPct,
  relatedData,
  buildRelationInsight,
  type RelationStats,
  type InsightLens,
} from "./transforms-insight";

import "server-only";

import {
  generateMockFine,
  generateMockIntraday,
  generateMockStockData,
  generateMockWeek,
} from "@/data/fallbacks";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import {
  getCandlesCached,
  getFineCached,
  getIntradayCached,
} from "../cache";
import { sanitizeTicker } from "../transforms";
import type { BarPoint } from "../types";

export type CandleData = {
  chart_data: BarPoint[];
  stock_price: number;
  price_change: number;
  percent_change: number;
  latest_volume?: number | null;
};

export const hasLivePrices = hasAlpaca || hasPolygon;

export async function getStockCandles(ticker: string): Promise<CandleData | null> {
  if (!hasLivePrices) return generateMockStockData(ticker);
  try {
    return await getCandlesCached(ticker);
  } catch (error) {
    console.error("Candles fetch failed:", error);
    return null;
  }
}

export async function getIntraday(ticker: string): Promise<BarPoint[]> {
  if (!hasLivePrices) return generateMockIntraday(ticker);
  try {
    const cached = await getIntradayCached(ticker);
    if (cached && cached.length >= 2) return cached;
  } catch (error) {
    console.error("Intraday fetch failed:", error);
  }
  return [];
}

export function sliceRecentDays(series: BarPoint[], days: number): BarPoint[] {
  if (series.length < 2) return series;
  const latest = Date.parse(series[series.length - 1].date);
  const cutoff = latest - days * 24 * 60 * 60 * 1000;
  const recent = series.filter((point) => Date.parse(point.date) >= cutoff);
  return recent.length >= 2 ? recent : series;
}

export function weekFromFine(fine: BarPoint[]): BarPoint[] {
  return fine.length >= 2 ? sliceRecentDays(fine, 8) : [];
}

export async function getWeek(ticker: string): Promise<BarPoint[]> {
  if (!hasLivePrices) return generateMockWeek(ticker);
  return weekFromFine(await getFine(ticker));
}

export async function getFine(ticker: string): Promise<BarPoint[]> {
  if (!hasLivePrices) return generateMockFine(ticker);
  try {
    const cached = await getFineCached(ticker);
    if (cached && cached.length >= 2) return cached;
  } catch (error) {
    console.error("Fine (15m) fetch failed:", error);
  }
  return [];
}

export async function getChartRangeData(
  ticker: string,
  kind: "daily" | "intraday" | "week" | "fine"
): Promise<BarPoint[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];
  switch (kind) {
    case "daily": {
      const data = await getStockCandles(symbol);
      return data?.chart_data ?? [];
    }
    case "intraday":
      return getIntraday(symbol);
    case "week":
      return getWeek(symbol);
    case "fine":
      return getFine(symbol);
  }
}

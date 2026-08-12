import "server-only";

import { hasAstra, hasFinnhub, hasPolygon } from "@/lib/config";
import {
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getTickerDetailCached,
  readAnalysisDocCached,
  readStoredArticlesCached,
} from "./cache";
import { getStockCandles, hasLivePrices } from "./price-queries";
import { sanitizeTicker } from "./transforms";

export async function warmMarketCaches(): Promise<void> {
  if (!hasLivePrices) return;
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
  if (hasLivePrices) tasks.push(getStockCandles(symbol));
  if (hasFinnhub || hasPolygon) tasks.push(getTickerDetailCached(symbol));
  if (hasAstra) {
    tasks.push(readStoredArticlesCached(symbol));
    tasks.push(readAnalysisDocCached(symbol));
  }
  if (tasks.length > 0) await Promise.allSettled(tasks);
}

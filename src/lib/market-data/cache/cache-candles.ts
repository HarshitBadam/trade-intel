import "server-only";

import { unstable_cache } from "next/cache";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import {
  mapPolygonAggs,
  mapAlpacaBars,
  mapAlpacaSnapshotQuote,
  type PolygonAggBar,
} from "../transforms";
import { polygonFetch } from "../providers/polygon";
import {
  getAlpacaBars,
  getAlpacaBarsLive,
  getAlpacaSnapshots,
  type AlpacaTimeframe,
} from "../providers/alpaca";
import type { BarPoint } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (ms: number) => new Date(ms).toISOString();

async function fetchBarsChain(
  ticker: string,
  alpacaTimeframe: AlpacaTimeframe,
  fromMs: number,
  toMs: number,
  polygonUrl: string,
  liveTail = false
): Promise<{ bars: BarPoint[]; source?: "Alpaca" | "Polygon" }> {
  let alpacaFailed = false;
  if (hasAlpaca) {
    try {
      const raw = liveTail
        ? await getAlpacaBarsLive(ticker, alpacaTimeframe, isoTime(fromMs), isoTime(toMs))
        : await getAlpacaBars(ticker, alpacaTimeframe, isoTime(fromMs), isoTime(toMs));
      const bars = mapAlpacaBars(raw);
      if (bars.length >= 2 || !hasPolygon) {
        return { bars, source: "Alpaca" };
      }
    } catch (error) {
      alpacaFailed = true;
      console.error(`[alpaca] ${alpacaTimeframe} bars failed for ${ticker}:`, error);
    }
  }
  if (hasPolygon) {
    const response = await polygonFetch(polygonUrl);
    if (!response.ok) {
      console.error(
        `[polygon] bars fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon bars failed: ${response.status}`);
    }
    const data = await response.json();
    return {
      bars: mapPolygonAggs((data.results ?? []) as PolygonAggBar[]),
      source: "Polygon",
    };
  }
  if (alpacaFailed) {
    throw new Error(`bars failed for ${ticker} with no available fallback`);
  }
  return { bars: [] };
}

export async function getCandlesFresh(ticker: string) {
  const to = Date.now();
  const from = to - 2 * 365 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const { bars, source } = await fetchBarsChain(
    ticker,
    "1Day",
    from,
    to,
    polygonUrl
  );
  if (bars.length < 2) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const result = {
    chart_data: bars,
    stock_price: last.value,
    price_change: last.value - prev.value,
    percent_change: ((last.value - prev.value) / prev.value) * 100,
    latest_volume: typeof last.volume === "number" ? Math.round(last.volume) : null,
    source,
  };

  if (hasAlpaca) {
    try {
      const snaps = await getAlpacaSnapshots([ticker]);
      const quote = mapAlpacaSnapshotQuote(ticker, snaps[ticker]);
      if (quote && quote.price > 0) {
        result.stock_price = quote.price;
        result.price_change = quote.change;
        result.percent_change = quote.percentChange;
        result.source = "Alpaca";
      }
    } catch (error) {
      console.error(`[alpaca] headline snapshot failed for ${ticker}:`, error);
    }
  }

  return result;
}

export const getCandlesCached = unstable_cache(getCandlesFresh, ["candles"], {
  revalidate: 300,
  tags: ["candles"],
});

async function fetchIntraday(ticker: string): Promise<BarPoint[] | null> {
  const to = Date.now();
  const from = to - 5 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const { bars } = await fetchBarsChain(
    ticker,
    "1Min",
    from,
    to,
    polygonUrl,
    true
  );
  if (bars.length < 2) return null;

  const lastDay = bars[bars.length - 1].date.slice(0, 10);
  const session = bars.filter((b) => b.date.slice(0, 10) === lastDay);
  return session.length >= 2 ? session : bars;
}

export const getIntradayCached = unstable_cache(fetchIntraday, ["intraday-1m"], {
  revalidate: 300,
  tags: ["candles"],
});

async function fetchFine(ticker: string): Promise<BarPoint[] | null> {
  const to = Date.now();
  const from = to - 96 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/15/minute/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const { bars } = await fetchBarsChain(
    ticker,
    "15Min",
    from,
    to,
    polygonUrl,
    true
  );
  if (bars.length < 2) return null;

  const latest = Date.parse(bars[bars.length - 1].date);
  const cutoff = latest - 92 * DAY_MS;
  const recent = bars.filter((b) => Date.parse(b.date) >= cutoff);
  return recent.length >= 2 ? recent : bars;
}

export const getFineCached = unstable_cache(fetchFine, ["fine-15m"], {
  revalidate: 300,
  tags: ["candles"],
});

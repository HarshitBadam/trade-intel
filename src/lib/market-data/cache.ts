import "server-only";

import { unstable_cache } from "next/cache";
import { News } from "@/components/news/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
  hasAlpaca,
  hasPolygon,
} from "@/lib/config";
import {
  mapPolygonAggs,
  mapAlpacaBars,
  mapAlpacaSnapshotQuote,
  type PolygonAggBar,
} from "./transforms";
import { polygonFetch } from "./polygon";
import { readAnalysisDoc, readTickerArticles } from "./news-store";
import {
  getAlpacaBars,
  getAlpacaBarsLive,
  getAlpacaSnapshots,
  type AlpacaTimeframe,
} from "./alpaca";
import type { BarPoint, StoredArticle, AnalysisDoc } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (ms: number) => new Date(ms).toISOString();

// Shared price-bar fetcher: Alpaca (real-time IEX, deep history) → Polygon
// aggregates → nothing (caller handles mock in demo mode). Both providers return
// `v`/`n`, so the resulting BarPoints always carry volume/trades. Throws when
// all configured providers fail so unstable_cache doesn't pin the failure.
async function fetchBarsChain(
  ticker: string,
  alpacaTimeframe: AlpacaTimeframe,
  fromMs: number,
  toMs: number,
  polygonUrl: string,
  liveTail = false
): Promise<BarPoint[]> {
  let alpacaFailed = false;
  if (hasAlpaca) {
    try {
      // Sub-daily series pass liveTail to stitch an IEX tail onto the SIP base
      // so the 1D/fine chart reaches ~now instead of stopping ~16 min back.
      const raw = liveTail
        ? await getAlpacaBarsLive(ticker, alpacaTimeframe, isoTime(fromMs), isoTime(toMs))
        : await getAlpacaBars(ticker, alpacaTimeframe, isoTime(fromMs), isoTime(toMs));
      const bars = mapAlpacaBars(raw);
      if (bars.length >= 2 || !hasPolygon) return bars;
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
    return mapPolygonAggs((data.results ?? []) as PolygonAggBar[]);
  }
  if (alpacaFailed) {
    throw new Error(`bars failed for ${ticker} with no available fallback`);
  }
  return [];
}

// Daily candles (~2y). Clamped to ~2y so the Polygon fallback stays inside the
// free tier's aggregate window (a 5y request 403s there); Alpaca is fine either way.
async function fetchCandles(ticker: string) {
  const to = Date.now();
  const from = to - 2 * 365 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const bars = await fetchBarsChain(ticker, "1Day", from, to, polygonUrl);
  if (bars.length < 2) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const result = {
    chart_data: bars,
    stock_price: last.value,
    price_change: last.value - prev.value,
    percent_change: ((last.value - prev.value) / prev.value) * 100,
    latest_volume: typeof last.volume === "number" ? Math.round(last.volume) : null,
  };

  // The daily bars are SIP, so the headline price lags ~16 min during market hours.
  // Best-effort override of the scalar price fields with the real-time IEX snapshot,
  // refreshed each 5-min cache window. chart_data/latest_volume stay SIP-derived
  // (full-market volume stays accurate); the snapshot's change is measured vs the
  // previous daily close, matching the day-change semantics.
  if (hasAlpaca) {
    try {
      const snaps = await getAlpacaSnapshots([ticker]);
      const quote = mapAlpacaSnapshotQuote(ticker, snaps[ticker]);
      if (quote && quote.price > 0) {
        result.stock_price = quote.price;
        result.price_change = quote.change;
        result.percent_change = quote.percentChange;
      }
    } catch (error) {
      console.error(`[alpaca] headline snapshot failed for ${ticker}:`, error);
    }
  }

  return result;
}

export const getCandlesCached = unstable_cache(fetchCandles, ["candles"], {
  revalidate: 300,
  tags: ["candles"],
});

async function fetchAstraNews(ticker: string): Promise<News[]> {
  const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
  const database = client.db(ASTRA_DB_API_ENDPOINT!);
  const table = database.collection<News>(ASTRA_DB_NEWS_COLLECTION);
  return table.find({ "metadata.ticker": ticker }).toArray();
}

export const getNewsCached = unstable_cache(fetchAstraNews, ["astra-news"], {
  revalidate: 600,
  tags: ["news"],
});

async function readStoredTickerArticles(ticker: string): Promise<StoredArticle[]> {
  return readTickerArticles(ticker, 200);
}

export const readStoredArticlesCached = unstable_cache(
  readStoredTickerArticles,
  ["store-ticker-articles"],
  { revalidate: 600, tags: ["news"] }
);

async function readTickerAnalysis(ticker: string): Promise<AnalysisDoc | null> {
  return readAnalysisDoc(ticker);
}

export const readAnalysisDocCached = unstable_cache(
  readTickerAnalysis,
  ["store-analysis-doc"],
  { revalidate: 600, tags: ["news"] }
);

// 1-minute intraday over the last few sessions, sliced to the latest session for
// the 1D view. Alpaca (real-time IEX) → Polygon 1-min aggregates.
async function fetchIntraday(ticker: string): Promise<BarPoint[] | null> {
  const to = Date.now();
  const from = to - 5 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const bars = await fetchBarsChain(ticker, "1Min", from, to, polygonUrl, true);
  if (bars.length < 2) return null;

  const lastDay = bars[bars.length - 1].date.slice(0, 10);
  const session = bars.filter((b) => b.date.slice(0, 10) === lastDay);
  return session.length >= 2 ? session : bars;
}

export const getIntradayCached = unstable_cache(fetchIntraday, ["intraday-1m"], {
  revalidate: 300,
  tags: ["candles"],
});

// 15-minute bars power 1W/1M/3M as a dense line. ~92 days is capped so the
// Polygon fallback stays under its 50k-result cap and inside the free window.
async function fetchFine(ticker: string): Promise<BarPoint[] | null> {
  const to = Date.now();
  const from = to - 96 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/15/minute/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const bars = await fetchBarsChain(ticker, "15Min", from, to, polygonUrl, true);
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

export {
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getSessionVolumesForCached,
  applySessionVolumes,
  volumeKey,
} from "./cache-market";

export { getQuotesForCached, getYearAgoQuotesForCached } from "./cache-quotes";

export {
  getTickerDetailCached,
  getRelatedTickersCached,
  searchTickersCached,
} from "./cache-meta";

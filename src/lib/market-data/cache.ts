import "server-only";

import { unstable_cache } from "next/cache";
import { News } from "@/components/news/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { FALLBACK_TICKERS } from "@/data/fallbacks";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
  POLYGON_API_KEY,
} from "@/lib/config";
import { mapPolygonNews, type PolygonNewsResult } from "./transforms";
import type {
  SearchResult,
  LiveQuote,
  TickerDetail,
  Mover,
} from "./types";

const MOVER_NAMES = new Map(FALLBACK_TICKERS.map((t) => [t.ticker, t.name]));
const MOVER_SYMBOLS = new Set(FALLBACK_TICKERS.map((t) => t.ticker));
type GroupedRow = { T: string; o: number; c: number; v: number };

export const getGroupedDailyCached = unstable_cache(
  async (): Promise<Mover[] | null> => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    for (let back = 1; back <= 6; back++) {
      const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
      const response = await fetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmt(
          day
        )}?adjusted=true`,
        {
          cache: "no-store",
          headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const rows = (data.results ?? []) as GroupedRow[];
      if (rows.length === 0) continue;

      const movers = rows
        .filter((r) => MOVER_SYMBOLS.has(r.T) && r.o > 0)
        .map((r) => ({
          ticker: r.T,
          name: MOVER_NAMES.get(r.T) ?? r.T,
          price: r.c,
          change: r.c - r.o,
          percentChange: ((r.c - r.o) / r.o) * 100,
          volume: r.v,
        }));
      if (movers.length > 0) return movers;
    }
    return null;
  },
  ["polygon-grouped-daily"],
  { revalidate: 3600, tags: ["movers"] }
);

export const getMarketMapCached = unstable_cache(
  async (): Promise<Record<string, LiveQuote>> => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    for (let back = 1; back <= 6; back++) {
      const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
      const response = await fetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmt(
          day
        )}?adjusted=true`,
        {
          cache: "no-store",
          headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const rows = (data.results ?? []) as GroupedRow[];
      if (rows.length === 0) continue;

      const map: Record<string, LiveQuote> = {};
      for (const r of rows) {
        if (r.o > 0) {
          map[r.T] = {
            ticker: r.T,
            price: r.c,
            change: r.c - r.o,
            percentChange: ((r.c - r.o) / r.o) * 100,
            volume: r.v,
          };
        }
      }
      return map;
    }
    return {};
  },
  ["polygon-market-map"],
  { revalidate: 3600, tags: ["movers"] }
);

export const getMarketMapYearAgoCached = unstable_cache(
  async (): Promise<Record<string, number>> => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    for (let back = 365; back >= 359; back--) {
      const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
      const response = await fetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmt(
          day
        )}?adjusted=true`,
        {
          cache: "no-store",
          headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const rows = (data.results ?? []) as GroupedRow[];
      if (rows.length === 0) continue;

      const map: Record<string, number> = {};
      for (const r of rows) if (r.c > 0) map[r.T] = r.c;
      return map;
    }
    return {};
  },
  ["polygon-market-map-year-ago"],
  { revalidate: 86_400, tags: ["movers"] }
);

export const getCandlesCached = unstable_cache(
  async (ticker: string) => {
    const to = new Date();
    // Polygon's free tier only entitles ~2 years of daily history; requesting 5
    // years returns a 403 NOT_AUTHORIZED for the whole call, which used to slip
    // through as "no data" and fall back to mock. Clamp to ~2y so the request
    // stays inside the free window (also a smaller payload / one fewer failure
    // mode).
    const from = new Date(to.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fmt(
        from
      )}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    // A non-ok response (429 rate limit / 403 entitlement) has no `results`, so
    // silently returning null here would cache the failure for the full
    // revalidate window and pin the chart to mock. Throw instead: unstable_cache
    // does NOT memoize a rejection, so the caller's try/catch falls back to mock
    // for just this render and the next request retries live.
    if (!response.ok) {
      console.error(
        `[polygon] candles fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon candles failed: ${response.status}`);
    }
    const stock_data = await response.json();

    const results = stock_data.results as
      | { t: number; c: number; o: number; v?: number }[]
      | undefined;
    if (!results || results.length < 2) return null;

    const last = results[results.length - 1];
    const prev = results[results.length - 2];
    return {
      chart_data: results.map((candle) => ({
        date: new Date(candle.t as number).toISOString(),
        value: candle.c as number,
      })),
      stock_price: last.c as number,
      price_change: (last.c as number) - (prev.c as number),
      percent_change:
        (((last.c as number) - (prev.c as number)) / (prev.c as number)) * 100,
      // Latest daily volume comes free with these bars — reuse it for the
      // popularity card instead of spending a second Polygon request on
      // getLatestVolumeCached. Shares are whole, so round for display.
      latest_volume: typeof last.v === "number" ? Math.round(last.v) : null,
    };
  },
  ["polygon-candles"],
  { revalidate: 300, tags: ["candles"] }
);

export const getNewsCached = unstable_cache(
  async (ticker: string): Promise<News[]> => {
    const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
    const database = client.db(ASTRA_DB_API_ENDPOINT!);
    const table = database.collection<News>(ASTRA_DB_NEWS_COLLECTION);
    return table.find({ "metadata.ticker": ticker }).toArray();
  },
  ["astra-news"],
  { revalidate: 600, tags: ["news"] }
);

export const getPolygonNewsCached = unstable_cache(
  async (ticker: string): Promise<News[]> => {
    const url =
      `https://api.polygon.io/v2/reference/news?ticker=${ticker}` +
      `&order=desc&sort=published_utc&limit=12`;
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
    });
    const data = await response.json();
    const results = (data.results ?? []) as PolygonNewsResult[];
    return mapPolygonNews(ticker, results);
  },
  ["polygon-news"],
  { revalidate: 600, tags: ["news"] }
);

// Wider news pull used only to build the popularity trend: the standard news
// fetch caps at 12 (headline list), but Polygon allows up to 1000 with a date
// filter, so we can bucket a real 90-day positive/negative series instead of
// mocking one. Cached hourly since it drives a trend, not a live headline feed.
export const getPopularityNewsCached = unstable_cache(
  async (ticker: string): Promise<News[]> => {
    const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const url =
      `https://api.polygon.io/v2/reference/news?ticker=${ticker}` +
      `&published_utc.gte=${from}&order=desc&sort=published_utc&limit=1000`;
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
    });
    // Throw (don't `return []`) on a transient failure so unstable_cache doesn't
    // pin an empty news trend for the full hour on a single 429. The caller
    // catches it and keeps the popularity card on its other source / mock.
    if (!response.ok) {
      console.error(
        `[polygon] popularity news fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon popularity news failed: ${response.status}`);
    }
    const data = await response.json();
    const results = (data.results ?? []) as PolygonNewsResult[];
    return mapPolygonNews(ticker, results);
  },
  ["polygon-popularity-news"],
  { revalidate: 3600, tags: ["news"] }
);

export const getIntradayCached = unstable_cache(
  async (ticker: string): Promise<{ date: string; value: number }[] | null> => {
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${fmt(
        from
      )}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    if (!response.ok) {
      console.error(
        `[polygon] intraday (1m) fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon intraday failed: ${response.status}`);
    }
    const data = await response.json();
    const results = data.results as { t: number; c: number }[] | undefined;
    if (!results || results.length < 2) return null;

    const lastDay = new Date(results[results.length - 1].t)
      .toISOString()
      .slice(0, 10);
    const session = results.filter(
      (c) => new Date(c.t).toISOString().slice(0, 10) === lastDay
    );
    const bars = session.length >= 2 ? session : results;
    return bars.map((c) => ({
      date: new Date(c.t).toISOString(),
      value: c.c,
    }));
  },
  ["polygon-intraday-1m"],
  { revalidate: 300, tags: ["candles"] }
);

export const getWeekCached = unstable_cache(
  async (ticker: string): Promise<{ date: string; value: number }[] | null> => {
    const to = new Date();
    const from = new Date(to.getTime() - 8 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/15/minute/${fmt(
        from
      )}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    if (!response.ok) {
      console.error(
        `[polygon] week (15m) fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon week failed: ${response.status}`);
    }
    const data = await response.json();
    const results = data.results as { t: number; c: number }[] | undefined;
    if (!results || results.length < 2) return null;

    const latest = results[results.length - 1].t;
    const cutoff = latest - 7 * 24 * 60 * 60 * 1000;
    const recent = results.filter((c) => c.t >= cutoff);
    const bars = recent.length >= 2 ? recent : results;
    return bars.map((c) => ({
      date: new Date(c.t).toISOString(),
      value: c.c,
    }));
  },
  ["polygon-week-15m"],
  { revalidate: 300, tags: ["candles"] }
);

// "Fine" powers the 1M/3M ranges at 15-minute resolution so those mid ranges
// render as a dense, Google-Finance-style line rather than a sparse one. ~92
// days of 15m bars is only ~2.5k rows — a single request that stays far under
// Polygon's 50k-result cap and inside the free tier's 2-year aggregate window.
// (A full year at this resolution would risk the cap, so the window is capped to
// a quarter.) It's still one on-demand cached call, just a bigger response.
export const getFineCached = unstable_cache(
  async (ticker: string): Promise<{ date: string; value: number }[] | null> => {
    const to = new Date();
    const from = new Date(to.getTime() - 96 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/15/minute/${fmt(
        from
      )}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    if (!response.ok) {
      console.error(
        `[polygon] fine (15m) fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon fine failed: ${response.status}`);
    }
    const data = await response.json();
    const results = data.results as { t: number; c: number }[] | undefined;
    if (!results || results.length < 2) return null;

    const latest = results[results.length - 1].t;
    const cutoff = latest - 92 * 24 * 60 * 60 * 1000;
    const recent = results.filter((c) => c.t >= cutoff);
    const bars = recent.length >= 2 ? recent : results;
    return bars.map((c) => ({
      date: new Date(c.t).toISOString(),
      value: c.c,
    }));
  },
  ["polygon-fine-15m"],
  { revalidate: 300, tags: ["candles"] }
);

export const getTickerDetailCached = unstable_cache(
  async (ticker: string): Promise<TickerDetail | null> => {
    const response = await fetch(
      `https://api.polygon.io/v3/reference/tickers/${ticker}`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const r = data.results;
    if (!r) return null;
    return {
      ticker,
      name: r.name ?? ticker,
      sicCode: r.sic_code ? String(r.sic_code) : null,
      sector: r.sic_description ?? null,
      marketCap: typeof r.market_cap === "number" ? r.market_cap : null,
    };
  },
  ["polygon-ticker-detail"],
  { revalidate: 86_400, tags: ["fundamentals"] }
);

export const getRelatedTickersCached = unstable_cache(
  async (ticker: string): Promise<string[]> => {
    const response = await fetch(
      `https://api.polygon.io/v1/related-companies/${ticker}`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    if (!response.ok) {
      throw new Error(`polygon related companies failed: ${response.status}`);
    }
    const data = await response.json();
    const rows = (data.results ?? []) as { ticker?: string }[];
    return rows.map((x) => x.ticker ?? "").filter(Boolean);
  },
  ["polygon-related-companies"],
  { revalidate: 86_400, tags: ["fundamentals"] }
);

const COMPANY_TICKER_TYPES = new Set([
  "CS",
  "ADRC",
  "ADRP",
  "GDR",
  "NYRS",
  "PFD",
  "NVDR",
]);

type PolygonTickerHit = { ticker: string; name?: string; type?: string };

function searchRelevance(hit: PolygonTickerHit, q: string): number {
  const tk = hit.ticker.toUpperCase();
  const name = (hit.name ?? "").toUpperCase();
  const isCompany = COMPANY_TICKER_TYPES.has(hit.type ?? "");

  let score = 0;
  if (tk === q) score -= 1000;
  score += isCompany ? 0 : 300;
  if (tk.startsWith(q)) score -= 80;
  else if (tk.includes(q)) score -= 20;
  if (name.startsWith(q)) score -= 30;
  score += tk.length;
  return score;
}

export const searchTickersCached = unstable_cache(
  async (query: string): Promise<SearchResult[]> => { // Fetch wide, then rank locally — Polygon's default order buries exact matches.
    const response = await fetch(
      `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(
        query
      )}&market=stocks&active=true&limit=30`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
    if (!response.ok) {
      throw new Error(`polygon ticker search failed: ${response.status}`);
    }
    const data = await response.json();
    if (data.status === "ERROR") {
      throw new Error(data.error ?? "polygon ticker search error");
    }
    const q = query.toUpperCase();
    const results = (data.results ?? []) as PolygonTickerHit[];
    return results
      .slice()
      .sort((a, b) => searchRelevance(a, q) - searchRelevance(b, q))
      .slice(0, 8)
      .map((s) => ({ ticker: s.ticker, name: s.name ?? s.ticker }));
  },
  ["polygon-ticker-search"],
  { revalidate: 86_400, tags: ["search"] }
);

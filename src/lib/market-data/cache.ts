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
    const from = new Date(to.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
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
    const stock_data = await response.json();

    const results = stock_data.results as
      | { t: number; c: number; o: number }[]
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

export const getFineCached = unstable_cache(
  async (ticker: string): Promise<{ date: string; value: number }[] | null> => {
    const to = new Date();
    const from = new Date(to.getTime() - 96 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/hour/${fmt(
        from
      )}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );
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
  ["polygon-fine-1h"],
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
    if (!response.ok) return [];
    const data = await response.json();
    const rows = (data.results ?? []) as { ticker?: string }[];
    return rows.map((x) => x.ticker ?? "").filter(Boolean);
  },
  ["polygon-related-companies"],
  { revalidate: 86_400, tags: ["fundamentals"] }
);

// Cached per query for a day; throws on non-OK so failures stay out of cache.
// COMPANY_TICKER_TYPES prioritizes real companies over ETFs/leveraged products.
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

// Lower = better: exact match > company type > prefix match > shorter ticker.
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
  async (query: string): Promise<SearchResult[]> => {
    // Fetch wide, then rank locally — Polygon's default order buries exact matches.
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

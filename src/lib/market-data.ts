import "server-only";

import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { News, NewsStatus } from "@/components/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import type { StockData } from "@/app/details/[id]/page";
import {
  FALLBACK_TICKERS,
  generateMockFine,
  generateMockWeek,
  generateMockIntraday,
  generateMockNews,
  generateMockPopularity,
  generateMockStockData,
  getCuratedPeers,
  type RelatedStock,
} from "@/data/fallbacks";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
  hasAstra,
  hasLangflowIngest,
  hasPolygon,
  POLYGON_API_KEY,
} from "@/lib/config";
import { formatVolume } from "@/lib/movers";
import { ingestTickerNews } from "@/lib/news-ingest";
import type {
  SearchResult,
  Quote,
  Headline,
  Mover,
  Movers,
  LiveQuote,
  ChatQuote,
  RelatedCard,
  NewsSummary,
  TickerDetail,
  Candidate,
} from "./market-data-types";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type {
  SearchResult,
  Quote,
  Headline,
  Mover,
  Movers,
  LiveQuote,
  ChatQuote,
  RelatedCard,
  NewsSummary,
  TickerDetail,
  Candidate,
} from "./market-data-types";

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════════

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

export function newsToHeadline(symbol: string, n: News): Headline {
  return {
    ticker: symbol,
    newsTitle: n.metadata.title,
    newsContent:
      n.metadata.description || n.metadata.key_observations || n.page_content,
    source: n.metadata.source,
    date: n.metadata.publication_date,
    url: n.metadata.url,
    sentiment: n.metadata.sentiment,
  };
}

const IMPORTANCE_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
export function pickTopArticle(news: News[]): News {
  return [...news].sort((a, b) => {
    const rank =
      (IMPORTANCE_RANK[b.metadata.importance] ?? 0) -
      (IMPORTANCE_RANK[a.metadata.importance] ?? 0);
    if (rank !== 0) return rank;
    const ta =
      Date.parse(a.metadata.ingested_at || a.metadata.publication_date || "") ||
      0;
    const tb =
      Date.parse(b.metadata.ingested_at || b.metadata.publication_date || "") ||
      0;
    return tb - ta;
  })[0];
}

export function mockHeadline(symbol: string): Headline {
  return newsToHeadline(symbol, generateMockNews(symbol || "AAPL")[0]);
}

export function normalizeSentiment(raw?: string): string {
  switch ((raw ?? "").toLowerCase()) {
    case "positive":
      return "Positive";
    case "negative":
      return "Negative";
    default:
      return "Neutral";
  }
}

type PolygonNewsResult = {
  id: string;
  publisher?: { name?: string };
  title?: string;
  published_utc?: string;
  article_url?: string;
  description?: string;
  insights?: { ticker: string; sentiment?: string; sentiment_reasoning?: string }[];
};

export function mapPolygonNews(ticker: string, results: PolygonNewsResult[]): News[] {
  return results.map((r) => {
    const insight =
      r.insights?.find((i) => i.ticker === ticker) ?? r.insights?.[0];
    const title = r.title ?? "Untitled";
    const description = r.description ?? title;
    return {
      _id: r.id,
      page_content: description,
      metadata: {
        title,
        source: r.publisher?.name ?? "Unknown",
        publication_date: (r.published_utc ?? "").slice(0, 10),
        importance: "Medium",
        sentiment: normalizeSentiment(insight?.sentiment),
        key_observations: insight?.sentiment_reasoning || description,
        url: r.article_url ?? "#",
        ticker: ticker,
        description,
        event: title,
      },
    };
  });
}

export function summarizeNews(
  news: News[],
  status: NewsStatus,
  updatedAt?: string
): NewsSummary {
  const mentions = news.length;
  const pct = (sentiment: string) =>
    mentions === 0
      ? 0
      : Math.round(
          (news.filter((n) => n.metadata.sentiment === sentiment).length /
            mentions) *
            100
        );
  return {
    mentions,
    positiveSentiment: pct("Positive"),
    negativeSentiment: pct("Negative"),
    news,
    status,
    updatedAt,
  };
}

export function mockNewsSummary(ticker: string): NewsSummary {
  return summarizeNews(generateMockNews(ticker), "sample");
}

export function latestNewsTimestamp(news: News[]): string | undefined {
  let latest = 0;
  for (const n of news) {
    const raw = n.metadata.ingested_at || n.metadata.publication_date;
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isNaN(t)) latest = Math.max(latest, t);
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined;
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
  const byAbs = [...all].sort(
    (a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange)
  );
  const byVolume = [...all].sort((a, b) => b.volume - a.volume);
  return {
    gainers: byPct.slice(0, 3),
    losers: byPct.slice(-3).reverse(),
    shifts: byAbs.slice(0, 3),
    mostActive: byVolume.slice(0, 3),
  };
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function formatMarketCap(v: number | null): string {
  if (!v || v <= 0) return "";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}

export function fmtPct(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export function relatedData(c: Candidate, reason: string): RelatedStock {
  let currentPrice: string;
  let priceChange: string;
  let percentageChange: string;
  let volume: string;
  let up: boolean;

  if (c.quote) {
    up = c.quote.percentChange >= 0;
    const sign = up ? "+" : "";
    currentPrice = `$${c.quote.price.toFixed(2)}`;
    priceChange = `${sign}${c.quote.change.toFixed(2)}`;
    percentageChange = `${sign}${c.quote.percentChange.toFixed(2)}%`;
    volume = formatVolume(c.quote.volume);
  } else {
    const m = generateMockStockData(c.ticker);
    up = m.price_change >= 0;
    const sign = up ? "+" : "";
    currentPrice = `$${m.stock_price.toFixed(2)}`;
    priceChange = `${sign}${m.price_change.toFixed(2)}`;
    percentageChange = `${sign}${m.percent_change.toFixed(2)}%`;
    volume = formatVolume(generateMockPopularity(c.ticker).searchVolume);
  }

  return {
    ticker: c.ticker,
    name: c.name,
    currentPrice,
    priceChange,
    percentageChange,
    volume,
    sentiment: up ? "Bullish" : "Bearish",
    sentimentSource: ["Polygon"],
    reason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cached fetchers (unstable_cache wrappers — keys/tags/revalidate unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

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
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/5/minute/${fmt(
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
  ["polygon-intraday"],
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

// Ticker type-ahead search, cached per query for a day (symbols don't churn) so
// each unique search hits Polygon's rate-limited free tier (~5 req/min) at most
// once and repeat typing is free. On a non-OK / 429 response we THROW: that
// keeps the failure OUT of the cache (so it isn't pinned for a day) and signals
// the caller to serve the local index instead, retrying Polygon fresh next time.
// Polygon `type` codes for genuine operating companies (vs. ETFs/funds/notes/
// warrants/etc.). When someone searches "TSLA" they want Tesla — not a pile of
// leveraged TSLA ETFs — so these are ranked first.
const COMPANY_TICKER_TYPES = new Set([
  "CS", // common stock
  "ADRC", // ADR common
  "ADRP", // ADR preferred
  "GDR", // global depositary receipt
  "NYRS", // NY registered shares
  "PFD", // preferred
  "NVDR", // non-voting depositary receipt
]);

type PolygonTickerHit = { ticker: string; name?: string; type?: string };

/**
 * Relevance score (lower = better) that mirrors how a real symbol search ranks:
 *   1. exact ticker match
 *   2. genuine companies (CS/ADR) over ETFs/funds/other instruments
 *   3. ticker-prefix match over name-only match
 *   4. shorter tickers first (TSLA before TSLAxx leveraged products)
 */
function searchRelevance(hit: PolygonTickerHit, q: string): number {
  const tk = hit.ticker.toUpperCase();
  const name = (hit.name ?? "").toUpperCase();
  const isCompany = COMPANY_TICKER_TYPES.has(hit.type ?? "");

  let score = 0;
  if (tk === q) score -= 1000; // exact symbol always wins
  score += isCompany ? 0 : 300; // demote ETFs/funds/etc. as a tier
  if (tk.startsWith(q)) score -= 80;
  else if (tk.includes(q)) score -= 20;
  if (name.startsWith(q)) score -= 30;
  score += tk.length; // tie-break toward the cleaner/shorter symbol
  return score;
}

export const searchTickersCached = unstable_cache(
  async (query: string): Promise<SearchResult[]> => {
    // Fetch a wider set than we show, then rank locally — Polygon returns
    // substring matches in no useful order, so without this "TSLA" leads with
    // leveraged ETFs instead of Tesla.
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

// ═══════════════════════════════════════════════════════════════════════════════
// Mid-level data accessors (with fallback-to-mock)
// ═══════════════════════════════════════════════════════════════════════════════

export async function getStockCandles(ticker: string) {
  if (hasPolygon) {
    try {
      const cached = await getCandlesCached(ticker);
      if (cached) return cached;
    } catch (error) {
      console.error("Polygon candles fetch failed, using fallback:", error);
    }
  }
  return generateMockStockData(ticker);
}

export async function getIntraday(ticker: string): Promise<{ date: string; value: number }[]> {
  if (hasPolygon) {
    try {
      const cached = await getIntradayCached(ticker);
      if (cached && cached.length >= 2) return cached;
    } catch (error) {
      console.error("Polygon intraday fetch failed, using fallback:", error);
    }
  }
  return generateMockIntraday(ticker);
}

export async function getWeek(ticker: string): Promise<{ date: string; value: number }[]> {
  if (hasPolygon) {
    try {
      const cached = await getWeekCached(ticker);
      if (cached && cached.length >= 2) return cached;
    } catch (error) {
      console.error("Polygon 15m fetch failed, using fallback:", error);
    }
  }
  return generateMockWeek(ticker);
}

export async function getFine(ticker: string): Promise<{ date: string; value: number }[]> {
  if (hasPolygon) {
    try {
      const cached = await getFineCached(ticker);
      if (cached && cached.length >= 2) return cached;
    } catch (error) {
      console.error("Polygon 1h fetch failed, using fallback:", error);
    }
  }
  return generateMockFine(ticker);
}

export async function getNews(ticker: string): Promise<NewsSummary> {
  let analyzing = false;

  if (hasAstra) {
    try {
      const news = await getNewsCached(ticker);
      if (news.length > 0) {
        return summarizeNews(news, "fresh", latestNewsTimestamp(news));
      }
      analyzing = scheduleNewsIngestion(ticker);
    } catch (error) {
      console.error("Astra DB news fetch failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    try {
      const news = await getPolygonNewsCached(ticker);
      if (news.length > 0) {
        return summarizeNews(news, analyzing ? "analyzing" : "live");
      }
    } catch (error) {
      console.error("Polygon news fetch failed, using fallback:", error);
    }
  }
  return summarizeNews(
    generateMockNews(ticker),
    analyzing ? "analyzing" : "sample"
  );
}

export function scheduleNewsIngestion(ticker: string): boolean {
  if (!hasLangflowIngest) return false;
  after(() => ingestTickerNews(ticker));
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// buildStockData (shared by details data fn and action fallbacks)
// ═══════════════════════════════════════════════════════════════════════════════

export function buildStockData(
  symbol: string,
  stock_data: ReturnType<typeof generateMockStockData>,
  intradayData: { date: string; value: number }[] | undefined,
  weekData: { date: string; value: number }[] | undefined,
  fineData: { date: string; value: number }[] | undefined,
  news: NewsSummary
): StockData {
  const pop = generateMockPopularity(symbol);
  return {
    id: symbol,
    companyName: symbol,
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    popularityRate: pop.popularityRate,
    mentions: news.mentions,
    searchVolume: pop.searchVolume,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    chartData: stock_data.chart_data,
    intradayData,
    weekData,
    fineData,
    news: news.news,
    newsStatus: news.status,
    newsUpdatedAt: news.updatedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public data functions (NO guard — RSC + cron call these directly)
// ═══════════════════════════════════════════════════════════════════════════════

export async function getMoversData(): Promise<Movers> {
  if (hasPolygon) {
    try {
      const live = await getGroupedDailyCached();
      if (live && live.length > 0) return summarizeMovers(live);
    } catch (error) {
      console.error("Polygon movers fetch failed, using fallback:", error);
    }
  }
  return summarizeMovers(mockMovers());
}

export async function getQuoteData(ticker: string): Promise<Quote> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockQuote("N/A");

  const [stock_data, intraday, week, fine] = await Promise.all([
    getStockCandles(symbol),
    getIntraday(symbol),
    getWeek(symbol),
    getFine(symbol),
  ]);

  return {
    ticker: symbol,
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    chartData: stock_data.chart_data,
    intradayData: intraday,
    weekData: week,
    fineData: fine,
  };
}

export async function getHeadlineData(ticker: string): Promise<Headline> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockHeadline("AAPL");

  if (hasAstra) {
    try {
      const news = await getNewsCached(symbol);
      if (news.length > 0) return newsToHeadline(symbol, pickTopArticle(news));
    } catch (error) {
      console.error("Astra headline fetch failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    try {
      const news = await getPolygonNewsCached(symbol);
      if (news.length > 0) return newsToHeadline(symbol, news[0]);
    } catch (error) {
      console.error("Polygon headline fetch failed, using fallback:", error);
    }
  }
  return mockHeadline(symbol);
}

export async function getLiveQuotes(tickers: string[]): Promise<LiveQuote[]> {
  if (!hasPolygon || tickers.length === 0) return [];
  try {
    const map = await getMarketMapCached();
    const seen = new Set<string>();
    const out: LiveQuote[] = [];
    for (const raw of tickers) {
      const t = raw.toUpperCase();
      if (seen.has(t)) continue;
      seen.add(t);
      if (map[t]) out.push(map[t]);
    }
    return out.slice(0, 4);
  } catch (error) {
    console.error("Live quote lookup failed:", error);
    return [];
  }
}

// Multi-horizon quotes for the chat. Unlike getLiveQuotes (which reads the
// market-wide grouped snapshot and can be empty before a session closes), this
// pulls per-ticker daily aggregates — the same reliable, free-tier source the
// detail page uses — so any mentioned ticker resolves to real numbers without
// needing the dashboard to have been visited first. Results are cached per
// ticker (shared with the detail page), so it adds no meaningful API cost.
export async function getChatQuotes(tickers: string[]): Promise<ChatQuote[]> {
  if (!hasPolygon || tickers.length === 0) return [];
  const uniq = [...new Set(tickers.map((t) => t.toUpperCase()))].slice(0, 3);

  const quotes = await Promise.all(
    uniq.map(async (ticker): Promise<ChatQuote | null> => {
      try {
        const c = await getCandlesCached(ticker);
        if (!c || c.chart_data.length < 2) return null;
        const closes = c.chart_data.map((d) => d.value);
        const i = closes.length - 1;
        const pctBack = (sessions: number): number | null => {
          const j = i - sessions;
          return j >= 0 && closes[j] > 0
            ? ((closes[i] - closes[j]) / closes[j]) * 100
            : null;
        };
        return {
          ticker,
          price: c.stock_price,
          dayPct: c.percent_change,
          weekPct: pctBack(5),
          monthPct: pctBack(21),
          yearPct: pctBack(252),
        };
      } catch {
        return null;
      }
    })
  );

  // Preserve the caller's ordering and drop any that failed to resolve.
  return uniq
    .map((t) => quotes.find((q) => q && q.ticker === t))
    .filter((q): q is ChatQuote => Boolean(q));
}

export async function getRelatedStocksData(
  ticker: string
): Promise<RelatedCard[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol || !hasPolygon) return [];

  try {
    const relatedTickers = await getRelatedTickersCached(symbol);
    let peerTickers = Array.from(new Set(relatedTickers.map(sanitizeTicker)))
      .filter((t) => t && t !== symbol)
      .slice(0, 8);

    if (peerTickers.length === 0) {
      peerTickers = Array.from(new Set(getCuratedPeers(symbol).map(sanitizeTicker)))
        .filter((t) => t && t !== symbol)
        .slice(0, 8);
    }

    if (peerTickers.length === 0) return [];

    const [marketMap, yearAgoMap, currentDetail, peerDetails] =
      await Promise.all([
        getMarketMapCached().catch(() => ({}) as Record<string, LiveQuote>),
        getMarketMapYearAgoCached().catch(() => ({}) as Record<string, number>),
        getTickerDetailCached(symbol).catch(() => null as TickerDetail | null),
        Promise.all(
          peerTickers.map((t) =>
            getTickerDetailCached(t).catch(() => null as TickerDetail | null)
          )
        ),
      ]);

    const returnOf = (t: string): number | null => {
      const now = marketMap[t]?.price;
      const ago = yearAgoMap[t];
      return now && ago ? (now / ago - 1) * 100 : null;
    };

    const candidates: Candidate[] = peerTickers.map((t, i) => {
      const d = peerDetails[i];
      const q = marketMap[t];
      return {
        ticker: t,
        name: d?.name ?? t,
        pct: q ? q.percentChange : null,
        ret1y: returnOf(t),
        volume: q ? q.volume : null,
        marketCap: d?.marketCap ?? null,
        sicCode: d?.sicCode ?? null,
        sector: d?.sector ?? null,
        quote: q,
      };
    });

    const curPct = marketMap[symbol]?.percentChange ?? null;
    const curRet = returnOf(symbol);
    const curVol = marketMap[symbol]?.volume ?? null;
    const curCap = currentDetail?.marketCap ?? null;
    const curSic = currentDetail?.sicCode ?? null;

    const used = new Set<string>();
    const remaining = () => candidates.filter((c) => !used.has(c.ticker));
    const byCategory: Record<string, RelatedCard> = {};
    const major = (s: string | null) => (s ? s.slice(0, 2) : "");

    const assignIndustry = (allowFuzzy: boolean) => {
      if (byCategory.industry) return;
      const rem = remaining();
      const pick =
        (curSic && rem.find((c) => c.sicCode === curSic)) ||
        (curSic && rem.find((c) => major(c.sicCode) === major(curSic))) ||
        (allowFuzzy ? rem.find((c) => c.sector) || rem[0] : undefined);
      if (!pick) return;
      used.add(pick.ticker);
      const exact = Boolean(curSic && pick.sicCode === curSic);
      const reason = pick.sector
        ? exact
          ? `Same industry as ${symbol}`
          : `${titleCase(pick.sector)} sector`
        : `Peer of ${symbol}`;
      byCategory.industry = {
        title: "Similar Industry",
        data: relatedData(pick, reason),
      };
    };

    assignIndustry(false);

    {
      const rem = remaining();
      let pick: Candidate | undefined;
      let reason = "";
      const withRet = rem.filter((c) => c.ret1y != null);
      if (curRet != null && withRet.length > 0) {
        pick = withRet.reduce((best, c) =>
          Math.abs(c.ret1y! - curRet) < Math.abs(best.ret1y! - curRet)
            ? c
            : best
        );
        reason = `1Y return ${fmtPct(pick.ret1y!)} (${symbol} ${fmtPct(
          curRet
        )})`;
      } else {
        const withPct = rem.filter((c) => c.pct != null);
        if (curPct != null && withPct.length > 0) {
          pick = withPct.reduce((best, c) =>
            Math.abs(c.pct! - curPct) < Math.abs(best.pct! - curPct) ? c : best
          );
          reason = `Daily move ${fmtPct(pick.pct!)} (${symbol} ${fmtPct(
            curPct
          )})`;
        } else {
          pick = rem[0];
          reason = pick ? `Moves with ${symbol}` : "";
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.return = {
          title: "Similar Return",
          data: relatedData(pick, reason),
        };
      }
    }

    {
      const rem = remaining();
      const withCap = rem.filter((c) => c.marketCap != null);
      let pick: Candidate | undefined;
      let reason = "";
      if (curCap != null && withCap.length > 0) {
        pick = withCap.reduce((best, c) =>
          Math.abs(Math.log(c.marketCap!) - Math.log(curCap)) <
          Math.abs(Math.log(best.marketCap!) - Math.log(curCap))
            ? c
            : best
        );
        reason = `${formatMarketCap(pick.marketCap)} market cap`;
      } else {
        const withVol = rem.filter((c) => c.volume != null);
        if (curVol != null && withVol.length > 0) {
          pick = withVol.reduce((best, c) =>
            Math.abs(c.volume! - curVol) < Math.abs(best.volume! - curVol)
              ? c
              : best
          );
          reason = `${formatVolume(pick.volume!)} daily volume`;
        } else {
          pick = rem[0];
          reason = pick ? `Related to ${symbol}` : "";
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.size = {
          title: "Similar Market Cap",
          data: relatedData(pick, reason),
        };
      }
    }

    assignIndustry(true);

    return [byCategory.return, byCategory.industry, byCategory.size].filter(
      (c): c is RelatedCard => Boolean(c)
    );
  } catch (error) {
    console.error("Related stocks fetch failed:", error);
    return [];
  }
}

export async function getDetailsData(ticker: string): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      undefined,
      undefined,
      undefined,
      mockNewsSummary("N/A")
    );
  }

  const [stock_data, news] = await Promise.all([
    getStockCandles(symbol),
    getNews(symbol),
  ]);

  return buildStockData(symbol, stock_data, undefined, undefined, undefined, news);
}

export async function getChartRangeData(
  ticker: string,
  kind: "daily" | "intraday" | "week" | "fine"
): Promise<{ date: string; value: number }[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  switch (kind) {
    case "daily": {
      const data = await getStockCandles(symbol);
      return data.chart_data;
    }
    case "intraday":
      return getIntraday(symbol);
    case "week":
      return getWeek(symbol);
    case "fine":
      return getFine(symbol);
  }
}

export async function getHomeData(defaultTicker: string): Promise<{
  movers: Movers;
  quote: Quote;
  headline: Headline;
}> {
  const [movers, quote, headline] = await Promise.all([
    getMoversData(),
    getQuoteData(defaultTicker),
    getHeadlineData(defaultTicker),
  ]);
  return { movers, quote, headline };
}

export async function getHomeTickerData(ticker: string): Promise<{
  quote: Quote;
  headline: Headline;
}> {
  const [quote, headline] = await Promise.all([
    getQuoteData(ticker),
    getHeadlineData(ticker),
  ]);
  return { quote, headline };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Warm helpers (for cron)
// ═══════════════════════════════════════════════════════════════════════════════

// Best-effort cache warming for the scheduled cron: prime the shared
// `unstable_cache` entries so a user's first visit is a warm hit. These are
// PURE cache reads and are self-protecting on cost-safety — every upstream
// call is gated on the same `hasPolygon`/`hasAstra` flags as the request path,
// so a `!liveAllowed` deployment can never spend here regardless of the caller.
// They deliberately do NOT touch the ingestion path (`getNews` → `after()`),
// keeping Gemini usage solely under the cron's explicit per-run cap.
export async function warmMarketCaches(): Promise<void> {
  if (!hasPolygon) return;
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
  if (hasPolygon) {
    tasks.push(getStockCandles(symbol), getTickerDetailCached(symbol));
  }
  // Warm the Astra READ cache only (no ingestion side effect).
  if (hasAstra) {
    tasks.push(getNewsCached(symbol));
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

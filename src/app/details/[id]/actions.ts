"use server";

import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { News, NewsStatus } from "@/components/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { StockData } from "./page";
import {
  FALLBACK_TICKERS,
  generateMockFine,
  generateMockWeek,
  generateMockIntraday,
  generateMockNews,
  generateMockPopularity,
  generateMockStockData,
  getCuratedPeers,
  searchFallbackTickers,
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
import { guard } from "@/lib/guard";
import { formatVolume } from "@/lib/movers";
import { ingestTickerNews } from "@/lib/news-ingest";

export type SearchResult = {
  ticker: string;
  name: string;
};

// A ticker is 1-5 letters; reject anything else before it reaches an API.
function sanitizeTicker(input: string): string {
  return (input ?? "").toString().toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 6);
}

export async function searchStocks(query: string): Promise<SearchResult[]> {
  const cleaned = (query ?? "").toString().slice(0, 64).trim();
  if (!cleaned) return [];

  // Search hits Polygon's reference API; rate-limit it. Fall back to local
  // results (no spend) on auth failure or throttle rather than erroring.
  const access = await guard("search", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return searchFallbackTickers(cleaned);
  }

  if (hasPolygon) {
    try {
      // Key goes in the Authorization header (not the URL) so it can't leak via
      // request logs, proxies or error traces.
      const url = `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(
        cleaned
      )}&market=stocks&active=true&limit=5`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      });
      const data = await response.json();

      if (data.results?.length) {
        return data.results.map((stock: { ticker: string; name?: string }) => ({
          ticker: stock.ticker,
          name: stock.name ?? stock.ticker,
        }));
      }
    } catch (error) {
      console.error(
        "Polygon ticker search failed, using fallback:",
        error instanceof Error ? error.message : "unknown error"
      );
    }
  }

  return searchFallbackTickers(cleaned);
}

export async function fetchDetails(ticker: string): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      generateMockIntraday("N/A"),
      generateMockWeek("N/A"),
      generateMockFine("N/A"),
      mockNewsSummary("N/A")
    );
  }

  // On auth failure / throttle, serve deterministic mock data (zero API spend).
  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return buildStockData(
      symbol,
      generateMockStockData(symbol),
      generateMockIntraday(symbol),
      generateMockWeek(symbol),
      generateMockFine(symbol),
      mockNewsSummary(symbol)
    );
  }

  const [stock_data, intraday, week, fine, news] = await Promise.all([
    getStockCandles(symbol),
    getIntraday(symbol),
    getWeek(symbol),
    getFine(symbol),
    getNews(symbol),
  ]);

  return buildStockData(symbol, stock_data, intraday, week, fine, news);
}

// ── Homepage "Trending Now" quote ───────────────────────────────────────────
// Lightweight version of fetchDetails for the homepage: just the price + chart
// series (daily + intraday), no news/ingestion. Cached fetchers keep repeated
// chip switches cheap and rate-limit safe.
export type Quote = {
  ticker: string;
  stockPrice: number;
  priceChange: number;
  percentChange: number;
  chartData: { date: string; value: number }[];
  intradayData: { date: string; value: number }[];
  weekData: { date: string; value: number }[];
  fineData: { date: string; value: number }[];
};

function mockQuote(symbol: string): Quote {
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

export async function fetchQuote(ticker: string): Promise<Quote> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockQuote("N/A");

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return mockQuote(symbol);

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

// ── Homepage "Top News" headline ────────────────────────────────────────────
export type Headline = {
  ticker: string;
  newsTitle: string;
  newsContent: string;
  source?: string;
  date?: string;
  url?: string;
  sentiment?: string;
};

// Maps a news row (Astra-enriched OR Polygon) into the homepage headline shape.
function newsToHeadline(symbol: string, n: News): Headline {
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

// Pick the single most "headline-worthy" enriched article: highest importance
// first, then the freshest (by ingestion, else publication date).
const IMPORTANCE_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
function pickTopArticle(news: News[]): News {
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

function mockHeadline(symbol: string): Headline {
  return newsToHeadline(symbol, generateMockNews(symbol || "AAPL")[0]);
}

export async function fetchTopHeadline(ticker: string): Promise<Headline> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockHeadline("AAPL");

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return mockHeadline(symbol);

  // 1. AI-enriched Astra article — richest content (analysis + real source URL)
  // and instant when the ticker has been warmed (on-demand visit or cron).
  if (hasAstra) {
    try {
      const news = await getNewsCached(symbol);
      if (news.length > 0) return newsToHeadline(symbol, pickTopArticle(news));
    } catch (error) {
      console.error("Astra headline fetch failed, trying Polygon:", error);
    }
  }
  // 2. Live Polygon headline for any other ticker.
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

// ── Homepage movers (Top Gainers / Losers / Sentiment Shifts) ───────────────
// Real day-over-day movement for a curated watchlist, derived from Polygon's
// "grouped daily" endpoint (one request returns every US ticker for a day, so
// this stays well within the free tier). Heavily cached; falls back to
// deterministic mock data so the homepage cards are never empty.
export type Mover = {
  ticker: string;
  name: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
};

export type Movers = {
  gainers: Mover[];
  losers: Mover[];
  shifts: Mover[];
  mostActive: Mover[];
};

const MOVER_NAMES = new Map(FALLBACK_TICKERS.map((t) => [t.ticker, t.name]));
const MOVER_SYMBOLS = new Set(FALLBACK_TICKERS.map((t) => t.ticker));

type GroupedRow = { T: string; o: number; c: number; v: number };

const getGroupedDailyCached = unstable_cache(
  async (): Promise<Mover[] | null> => {
    // Walk back from yesterday to find the most recent day with data (skips
    // weekends/holidays). One request per day attempt; capped at 6.
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

function mockMovers(): Mover[] {
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

function summarizeMovers(all: Mover[]): Movers {
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

export async function fetchMovers(): Promise<Movers> {
  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) return summarizeMovers(mockMovers());

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

// ── Live quotes for the chat layer ──────────────────────────────────────────
// A whole-market snapshot from the (free-tier) grouped-daily endpoint, keyed by
// ticker so the chat can attach real price/%-change/volume to any symbol a user
// mentions. One cached upstream call serves every lookup.
export type LiveQuote = {
  ticker: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
};

const getMarketMapCached = unstable_cache(
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

// Close price for every US ticker ~1 trading year ago. Combined with the
// current snapshot above this yields a 1-year RETURN for any symbol from just
// one extra (heavily cached) request — far cheaper than pulling per-ticker
// candle history. Used to match "Similar Return" on real annual performance
// rather than a single day's noise.
const getMarketMapYearAgoCached = unstable_cache(
  async (): Promise<Record<string, number>> => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    // Start ~365 days back and walk forward over holidays/weekends.
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

function buildStockData(
  symbol: string,
  stock_data: ReturnType<typeof generateMockStockData>,
  intradayData: { date: string; value: number }[],
  weekData: { date: string; value: number }[],
  fineData: { date: string; value: number }[],
  news: NewsSummary
): StockData {
  // Popularity/search-volume have no live source; derive stable per-ticker
  // values (the UI labels this view as illustrative).
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

type NewsSummary = {
  mentions: number;
  positiveSentiment: number;
  negativeSentiment: number;
  news: News[];
  /** Where the shown news came from — drives the UI provenance badge. */
  status: NewsStatus;
  /** ISO timestamp of the freshest article (only meaningful for `fresh`). */
  updatedAt?: string;
};

function summarizeNews(
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

function mockNewsSummary(ticker: string): NewsSummary {
  return summarizeNews(generateMockNews(ticker), "sample");
}

// Freshness for the "updated Xh ago" label: prefer the Expander's `ingested_at`
// (when present), else fall back to the article's publication_date. Returns the
// most recent timestamp across all rows as an ISO string.
function latestNewsTimestamp(news: News[]): string | undefined {
  let latest = 0;
  for (const n of news) {
    const raw = n.metadata.ingested_at || n.metadata.publication_date;
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isNaN(t)) latest = Math.max(latest, t);
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

// ── Cached live fetchers ────────────────────────────────────────────────────
// Caching collapses repeated requests for the same ticker into a single
// upstream call, cutting both API spend (Polygon/Astra) and Vercel function
// time. Keyed purely by ticker so it's safe to memoize.

const getCandlesCached = unstable_cache(
  async (ticker: string) => {
    const to = new Date();
    // ~5 years of daily history so the "All"/"1Y" ranges are fully populated.
    const from = new Date(to.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // Authorization header (not URL query) to keep the key out of logs.
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

const getNewsCached = unstable_cache(
  async (ticker: string): Promise<News[]> => {
    const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
    const database = client.db(ASTRA_DB_API_ENDPOINT!);
    const table = database.collection<News>(ASTRA_DB_NEWS_COLLECTION);
    return table.find({ "metadata.ticker": ticker }).toArray();
  },
  ["astra-news"],
  { revalidate: 600, tags: ["news"] }
);

// ── Live news breadth (Polygon) ─────────────────────────────────────────────
// Astra only holds AI-enriched news for curated tickers. For every other ticker
// we fetch real headlines on demand from Polygon's news endpoint so the product
// is usable for ANY symbol, not just the ones we pre-ingested. Polygon news is
// already covered by the existing Polygon key (no new dependency).

type PolygonNewsResult = {
  id: string;
  publisher?: { name?: string };
  title?: string;
  published_utc?: string;
  article_url?: string;
  description?: string;
  insights?: { ticker: string; sentiment?: string; sentiment_reasoning?: string }[];
};

// Normalise Polygon's lowercase sentiment to the capitalised form the UI's
// sentiment math expects ("Positive" | "Negative" | "Neutral").
function normalizeSentiment(raw?: string): string {
  switch ((raw ?? "").toLowerCase()) {
    case "positive":
      return "Positive";
    case "negative":
      return "Negative";
    default:
      return "Neutral";
  }
}

function mapPolygonNews(ticker: string, results: PolygonNewsResult[]): News[] {
  return results.map((r) => {
    // Prefer the sentiment insight scoped to this ticker; fall back to the first.
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
        // Polygon has no importance signal; default to Medium so the UI's
        // significance dot/`.toUpperCase()` always has a value.
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

const getPolygonNewsCached = unstable_cache(
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

async function getStockCandles(ticker: string) {
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

// ── Intraday candles (powers the 1D range) ──────────────────────────────────
// Fetches 5-minute bars over the last few days (to clear weekends/holidays),
// then keeps only the most recent session so 1D shows a single trading day.
const getIntradayCached = unstable_cache(
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

    // Keep only the latest session's bars (same UTC calendar day as the last bar).
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

async function getIntraday(ticker: string): Promise<{ date: string; value: number }[]> {
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

// ── 15-minute candles (power the 1W range) ──────────────────────────────────
// 15-min bars over the last ~8 days give the 1W view a high-resolution series
// (~130 trading-hour points for a real ticker) rather than the coarser hourly
// tier used for 1M / 3M.
const getWeekCached = unstable_cache(
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

    // Keep the last 7 days of bars relative to the latest one.
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

async function getWeek(ticker: string): Promise<{ date: string; value: number }[]> {
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

// ── 1-hour candles (power the 1M / 3M ranges) ───────────────────────────────
// Hourly bars over the last ~95 days keep the medium ranges densely bucketed
// (hundreds of points) instead of a blocky daily zigzag. 6M+ stays on daily
// candles. Live tickers only return trading-hour bars (~7/day), so a month is
// ~150 points and three months ~450 — all smooth.
const getFineCached = unstable_cache(
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

    // Keep the last ~92 days of bars relative to the latest one.
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

async function getFine(ticker: string): Promise<{ date: string; value: number }[]> {
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

async function getNews(ticker: string): Promise<NewsSummary> {
  // Tracks whether we've kicked off a background enrichment for this ticker. If
  // so, the result is marked `analyzing` so the client polls back once Astra has
  // the AI-enriched rows.
  let analyzing = false;

  // 1. Enriched (AI-analysed) news from Astra — best quality, curated tickers.
  if (hasAstra) {
    try {
      const news = await getNewsCached(ticker);
      if (news.length > 0) {
        return summarizeNews(news, "fresh", latestNewsTimestamp(news));
      }
      // No enriched news yet for this ticker: trigger a one-time background
      // Langflow ingestion so future visits upgrade from Polygon headlines to
      // AI-enriched analysis served from Astra. Serve Polygon now (below) but
      // flag the result as `analyzing` so the client re-fetches shortly.
      analyzing = scheduleNewsIngestion(ticker);
    } catch (error) {
      console.error("Astra DB news fetch failed, trying Polygon:", error);
    }
  }
  // 2. Live breadth — real headlines for ANY ticker via Polygon.
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
  // 3. Deterministic mock — keeps the UI populated with zero config / spend.
  // If an ingest is in flight we still surface `analyzing` so the placeholder
  // mock is replaced by enriched data on the next poll.
  return summarizeNews(
    generateMockNews(ticker),
    analyzing ? "analyzing" : "sample"
  );
}

// ── On-demand AI news ingestion (Langflow → Astra) ──────────────────────────
// Lazily enrich any ticker the user visits. The heavy work (Tavily search +
// Gemini extraction, ~15-25s) runs AFTER the response is sent via `after()`, so
// it never blocks the page. The actual ingest implementation is shared with the
// scheduled cron warm-up in `@/lib/news-ingest` so both paths stay in sync.

function scheduleNewsIngestion(ticker: string): boolean {
  if (!hasLangflowIngest) return false;
  after(() => ingestTickerNews(ticker));
  return true;
}

// ── Related stocks (genuine peers) ──────────────────────────────────────────
// The details-page rail shows companies actually comparable to the one being
// viewed, sourced from Polygon's "related companies" model (its own peer/
// competitor graph). Crucially we do NOT pad the list with a generic mega-cap
// watchlist — that's what produced absurd "peers" (e.g. AAPL shown next to a
// $47B mid-cap). When Polygon has no peer data for a symbol (common for ADRs
// like INFY) we simply HIDE the rail rather than invent irrelevant cards.
//
// Free-tier reality: Polygon throttles at ~5 req/min, so we keep this lean —
// one related-companies call + the already-cached market snapshot for live
// prices, plus a best-effort per-peer fundamentals lookup (sector + market cap)
// that's cached for a day and degrades gracefully to "just the live quote" when
// throttled. Everything is cached so steady-state cost is ~zero.

export type RelatedCard = { title: string; data: RelatedStock };

type TickerDetail = {
  ticker: string;
  name: string;
  sicCode: string | null;
  sector: string | null;
  marketCap: number | null;
};

const getTickerDetailCached = unstable_cache(
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
      // sic_code / sic_description are Polygon's industry classification (e.g.
      // 3571 "ELECTRONIC COMPUTERS") — the closest free-tier proxy for sector.
      sicCode: r.sic_code ? String(r.sic_code) : null,
      sector: r.sic_description ?? null,
      marketCap: typeof r.market_cap === "number" ? r.market_cap : null,
    };
  },
  ["polygon-ticker-detail"],
  { revalidate: 86_400, tags: ["fundamentals"] }
);

const getRelatedTickersCached = unstable_cache(
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

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatMarketCap(v: number | null): string {
  if (!v || v <= 0) return "";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}

// A peer enriched with everything we need to rank it along each lens. Live
// figures (return / volume) come from the free market snapshot; fundamentals
// (sector / market cap) from the cached per-ticker lookup (may be null when the
// free tier throttles — the card still renders from the live quote).
type Candidate = {
  ticker: string;
  name: string;
  pct: number | null;
  ret1y: number | null;
  volume: number | null;
  marketCap: number | null;
  sicCode: string | null;
  sector: string | null;
  quote: LiveQuote | undefined;
};

function fmtPct(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

// Turn a candidate + a "why it's here" reason into a TopGainer card payload.
function relatedData(c: Candidate, reason: string): RelatedStock {
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
    // No live quote (cache cold / outside the snapshot): deterministic mock so
    // the card shows stable, plausible numbers instead of blanks.
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

export async function fetchRelatedStocks(
  ticker: string
): Promise<RelatedCard[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok || !hasPolygon) return [];

  try {
    const relatedTickers = await getRelatedTickersCached(symbol);
    let peerTickers = Array.from(new Set(relatedTickers.map(sanitizeTicker)))
      .filter((t) => t && t !== symbol)
      .slice(0, 8);

    // Polygon's peer graph is empty for many foreign ADRs (INFY, TSM, BABA …)
    // and times out under free-tier throttling. Fall back to an editorial map
    // of GENUINE industry competitors so the rail stays populated with relevant
    // names — never padded with random mega-caps. Peers still get live prices
    // and the same ranking treatment below.
    if (peerTickers.length === 0) {
      peerTickers = Array.from(new Set(getCuratedPeers(symbol).map(sanitizeTicker)))
        .filter((t) => t && t !== symbol)
        .slice(0, 8);
    }

    // Still nothing relevant (genuinely obscure ticker): hide the rail rather
    // than invent peers.
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

    // 1-year return = (latest close / close ~1y ago − 1). Same metric the chart
    // shows by default, so the lens matches what the user actually sees.
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

    // Greedy, distinct assignment (no ticker repeats across cards). A STRONG
    // industry match (same SIC / SIC group) is claimed first because it's the
    // most specific signal; otherwise the precise numeric lenses (return, then
    // market cap) pick their best match and industry takes a sensible leftover.
    const used = new Set<string>();
    const remaining = () => candidates.filter((c) => !used.has(c.ticker));
    const byCategory: Record<string, RelatedCard> = {};
    const major = (s: string | null) => (s ? s.slice(0, 2) : "");

    // ── Similar Industry: same SIC, else same 2-digit SIC group; only when
    // `allowFuzzy` do we settle for "any peer with a known sector".
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

    // 1. Strong industry match gets first pick (rare but most meaningful).
    assignIndustry(false);

    // 2. Similar Return: closest 1-year return (the chart's default metric).
    // Falls back to the latest daily move only when annual data is unavailable.
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

    // 3. Similar Market Cap: closest market cap; falls back to closest traded
    // volume when fundamentals are unavailable (the "/volume" half of the lens).
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

    // 4. No strong industry match earlier → fill it now from the leftovers.
    assignIndustry(true);

    // Stable display order: Return · Industry · Market Cap.
    return [byCategory.return, byCategory.industry, byCategory.size].filter(
      (c): c is RelatedCard => Boolean(c)
    );
  } catch (error) {
    console.error("Related stocks fetch failed:", error);
    return [];
  }
}

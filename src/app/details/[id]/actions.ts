"use server";

import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { News, NewsStatus } from "@/components/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { StockData } from "./page";
import {
  generateMockNews,
  generateMockStockData,
  searchFallbackTickers,
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
    return buildStockData("N/A", generateMockStockData("N/A"), mockNewsSummary("N/A"));
  }

  // On auth failure / throttle, serve deterministic mock data (zero API spend).
  const access = await guard("details", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return buildStockData(
      symbol,
      generateMockStockData(symbol),
      mockNewsSummary(symbol)
    );
  }

  const [stock_data, news] = await Promise.all([
    getStockCandles(symbol),
    getNews(symbol),
  ]);

  return buildStockData(symbol, stock_data, news);
}

function buildStockData(
  symbol: string,
  stock_data: ReturnType<typeof generateMockStockData>,
  news: NewsSummary
): StockData {
  return {
    id: symbol,
    companyName: symbol,
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    popularityRate: 92,
    mentions: news.mentions,
    searchVolume: 850000,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    chartData: stock_data.chart_data,
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
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
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

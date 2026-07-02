import { News, NewsStatus } from "@/components/news/RecentInfluential";
import {
  FALLBACK_TICKERS,
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockNews,
  generateMockPopularity,
  type RelatedStock,
} from "@/data/fallbacks";
import { formatVolume, moveStrength } from "@/lib/movers";
import type {
  Quote,
  Headline,
  Mover,
  Movers,
  NewsSummary,
  Candidate,
} from "./types";

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

export type PolygonNewsResult = {
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
  let pct: number;

  if (c.quote) {
    pct = c.quote.percentChange;
    up = pct >= 0;
    const sign = up ? "+" : "";
    currentPrice = `$${c.quote.price.toFixed(2)}`;
    priceChange = `${sign}${c.quote.change.toFixed(2)}`;
    percentageChange = `${sign}${pct.toFixed(2)}%`;
    volume = formatVolume(c.quote.volume);
  } else {
    const m = generateMockStockData(c.ticker);
    pct = m.percent_change;
    up = pct >= 0;
    const sign = up ? "+" : "";
    currentPrice = `$${m.stock_price.toFixed(2)}`;
    priceChange = `${sign}${m.price_change.toFixed(2)}`;
    percentageChange = `${sign}${pct.toFixed(2)}%`;
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
    sentimentSource: [moveStrength(pct)],
    reason,
  };
}

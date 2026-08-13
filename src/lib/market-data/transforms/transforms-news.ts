import { generateMockNews } from "@/data/fallbacks";
import type {
  DataStatus,
  Headline,
  News,
  NewsStatus,
  NewsSummary,
  PopularitySeriesPoint,
} from "../types";

export type PolygonNewsResult = {
  id: string;
  publisher?: { name?: string };
  title?: string;
  published_utc?: string;
  article_url?: string;
  description?: string;
  insights?: { ticker: string; sentiment?: string; sentiment_reasoning?: string }[];
};

export function newsToHeadline(
  symbol: string,
  n: News,
  status: DataStatus
): Headline {
  return {
    ticker: symbol,
    newsTitle: n.metadata.title,
    newsContent: n.metadata.description || n.metadata.key_observations || n.page_content,
    source: n.metadata.source,
    date: n.metadata.publication_date,
    url: n.metadata.url,
    sentiment: n.metadata.sentiment,
    status,
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
      Date.parse(a.metadata.ingested_at || a.metadata.publication_date || "") || 0;
    const tb =
      Date.parse(b.metadata.ingested_at || b.metadata.publication_date || "") || 0;
    return tb - ta;
  })[0];
}

export function mockHeadline(symbol: string): Headline {
  return newsToHeadline(symbol, generateMockNews(symbol || "AAPL")[0], "sample");
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

export function mapPolygonNews(ticker: string, results: PolygonNewsResult[]): News[] {
  return results.map((r) => {
    const insight = r.insights?.find((i) => i.ticker === ticker) ?? r.insights?.[0];
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
        ticker,
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
          (news.filter((n) => n.metadata.sentiment === sentiment).length / mentions) * 100
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

// Popularity trend spans ~90 days, bucketed daily. Daily is the finest
// resolution the data supports since news `publication_date` is date-only.
export const POPULARITY_WINDOW_DAYS = 90;
const POPULARITY_BUCKET_DAYS = 1;

function articleTime(n: News): number {
  const raw = n.metadata.publication_date || n.metadata.ingested_at;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

export function windowNews(
  news: News[],
  windowDays = POPULARITY_WINDOW_DAYS,
  now: number = Date.now()
): News[] {
  const start = now - windowDays * 24 * 60 * 60 * 1000;
  return news.filter((n) => {
    const t = articleTime(n);
    return !Number.isNaN(t) && t >= start && t <= now;
  });
}

export function dedupeNews(news: News[]): News[] {
  const seen = new Set<string>();
  const out: News[] = [];
  for (const n of news) {
    const url = n.metadata.url && n.metadata.url !== "#" ? n.metadata.url : "";
    const key = url || n._id || n.metadata.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function buildPopularitySeries(
  news: News[],
  windowDays = POPULARITY_WINDOW_DAYS,
  bucketDays = POPULARITY_BUCKET_DAYS
): PopularitySeriesPoint[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const start = now - windowDays * dayMs;
  const bucketMs = bucketDays * dayMs;
  const bucketCount = Math.ceil(windowDays / bucketDays);

  const buckets: PopularitySeriesPoint[] = Array.from(
    { length: bucketCount },
    (_, i) => ({
      date: new Date(start + i * bucketMs).toISOString().slice(0, 10),
      positive: 0,
      negative: 0,
    })
  );

  for (const n of news) {
    const t = articleTime(n);
    if (Number.isNaN(t) || t < start || t > now) continue;
    const idx = Math.min(bucketCount - 1, Math.floor((t - start) / bucketMs));
    if (n.metadata.sentiment === "Positive") buckets[idx].positive += 1;
    else if (n.metadata.sentiment === "Negative") buckets[idx].negative += 1;
  }
  return buckets;
}

export function computePopularityScore(news: News[]): number {
  const now = Date.now();
  const start = now - POPULARITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  let positive = 0;
  let negative = 0;
  let total = 0;
  for (const n of news) {
    const t = articleTime(n);
    if (Number.isNaN(t) || t < start) continue;
    total += 1;
    if (n.metadata.sentiment === "Positive") positive += 1;
    else if (n.metadata.sentiment === "Negative") negative += 1;
  }
  const posNeg = positive + negative;
  const sentimentScore = posNeg > 0 ? (positive / posNeg) * 100 : 50;
  // Attention term saturates so a few articles register without volume dominating the score.
  const attentionScore = (1 - Math.exp(-total / 12)) * 100;
  return Math.round(0.6 * sentimentScore + 0.4 * attentionScore);
}

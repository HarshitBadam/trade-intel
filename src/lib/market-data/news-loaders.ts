import "server-only";

import {
  ALPACA_API_KEY_ID,
  ALPACA_API_SECRET_KEY,
  POLYGON_API_KEY,
} from "@/lib/config";
import { mapPolygonNews, type PolygonNewsResult } from "./transforms";
import { stableArticleId, touchNewsLoadedAt, upsertArticles } from "./news-store";
import type { StoredArticle } from "./types";

// Provider → store loaders for the background news lanes (redesign §5). These
// are deliberately plain fetches with NO limiter/queue: pacing Polygon's
// 5/min budget is the cron caller's job (a sequential loop with a sleep), and
// wrapping a second budget around it here would re-create the machinery the
// redesign deletes. Callers own retries too — throwing on a bad status is the
// whole error contract.

function articleIdFor(
  ticker: string,
  url: string | undefined,
  title: string,
  publicationDate: string
): string {
  return stableArticleId(url, `${ticker}|${title}|${publicationDate}`);
}

// Fetch Polygon news (newest first) and map to store rows. The News-shape
// mapping is EXACTLY the one the request path already applies to live Polygon
// news (mapPolygonNews), so stored rows and live rows can never drift; on top
// of it each row gets the store's identity + provenance fields, and
// `sentiment_reasoning` is kept as its own field (mapPolygonNews only folds it
// into key_observations) so the deep pass can see what Polygon's label was
// based on.
export async function fetchPolygonNewsWithInsights(
  ticker: string,
  limit = 50
): Promise<StoredArticle[]> {
  const symbol = ticker.trim().toUpperCase();
  // The 90-day floor matches retention (§9) and the request path's existing
  // Polygon window: anything older would be pruned right after storing, and
  // the next load would re-insert it — pure churn.
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const url =
    `https://api.polygon.io/v2/reference/news?ticker=${symbol}` +
    `&published_utc.gte=${from}&limit=${limit}&sort=published_utc&order=desc`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`polygon news failed for ${symbol}: ${response.status}`);
  }
  const data = await response.json();
  const results = (data.results ?? []) as PolygonNewsResult[];
  const ingestedAt = new Date().toISOString();

  // mapPolygonNews is a pure 1:1 map, so zipping by index is safe.
  return mapPolygonNews(symbol, results).map((article, i) => {
    const raw = results[i];
    const insight =
      raw.insights?.find((x) => x.ticker === symbol) ?? raw.insights?.[0];
    const id = articleIdFor(
      symbol,
      raw.article_url,
      article.metadata.title,
      article.metadata.publication_date
    );
    return {
      ...article,
      _id: id,
      metadata: {
        ...article.metadata,
        ingested_at: ingestedAt,
        article_id: id,
        label_source: "polygon",
        ...(insight?.sentiment_reasoning
          ? { sentiment_reasoning: insight.sentiment_reasoning }
          : {}),
      },
    };
  });
}

// One cron step for one ticker: pull Polygon's newest articles into the store
// and stamp the load time. No sleeps here — the cron loop paces itself.
export async function loadTickerNews(ticker: string): Promise<{
  ticker: string;
  fetched: number;
  upserted: number;
  inserted: number;
  skippedAi: number;
}> {
  const symbol = ticker.trim().toUpperCase();
  const articles = await fetchPolygonNewsWithInsights(symbol);
  const result = await upsertArticles(symbol, articles);
  await touchNewsLoadedAt(symbol);
  return {
    ticker: symbol,
    fetched: articles.length,
    upserted: result.upserted,
    inserted: result.inserted,
    skippedAi: result.skippedAi,
  };
}

type AlpacaNewsItem = {
  id?: number;
  headline?: string;
  summary?: string;
  source?: string;
  url?: string;
  created_at?: string;
};

// Alpaca (Benzinga) news mapped to the same store row shape — the request
// path's fallback source for a cold ticker the cron hasn't reached (Task 5
// wires it in; nothing calls this yet). PURE fetch+map: it must stay writable
// from the hot path, so it never touches Astra. Benzinga carries no sentiment,
// so rows are Neutral until the deep pass relabels them (they count neutral in
// the gauge, per redesign §5).
export async function fetchAlpacaNews(
  ticker: string,
  limit = 24
): Promise<StoredArticle[]> {
  const symbol = ticker.trim().toUpperCase();
  const params = new URLSearchParams({
    symbols: symbol,
    limit: String(limit),
    sort: "desc",
  });
  const response = await fetch(
    `https://data.alpaca.markets/v1beta1/news?${params.toString()}`,
    {
      cache: "no-store",
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY_ID ?? "",
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY ?? "",
      },
    }
  );
  if (!response.ok) {
    throw new Error(`alpaca news failed for ${symbol}: ${response.status}`);
  }
  const data = await response.json();
  const items = (data.news ?? []) as AlpacaNewsItem[];
  const ingestedAt = new Date().toISOString();

  return items.map((item) => {
    const title = item.headline || "Untitled";
    const description = item.summary || title;
    const publicationDate = (item.created_at ?? "").slice(0, 10);
    const id = articleIdFor(symbol, item.url, title, publicationDate);
    // Benzinga reports sources in lowercase ("benzinga"); capitalize so the
    // byline renders like the other providers'.
    const source = item.source
      ? item.source.charAt(0).toUpperCase() + item.source.slice(1)
      : "Benzinga";
    return {
      _id: id,
      page_content: description,
      metadata: {
        title,
        source,
        publication_date: publicationDate,
        importance: "Medium",
        sentiment: "Neutral",
        key_observations: description,
        url: item.url ?? "#",
        ticker: symbol,
        description,
        event: title,
        ingested_at: ingestedAt,
        article_id: id,
        label_source: "alpaca",
      },
    };
  });
}

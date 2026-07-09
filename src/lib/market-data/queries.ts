import "server-only";

import type { StockData } from "@/app/details/[id]/page";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockNews,
  generateMockPopularity,
} from "@/data/fallbacks";
import { hasAstra, hasAlpaca, hasFinnhub, hasPolygon } from "@/lib/config";
import type { News } from "@/components/news/RecentInfluential";
import type { NewsSummary, PopularityData, BarPoint, AnalysisDoc, StoredArticle } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

// Any provider that yields real price bars. Alpaca is preferred; Polygon
// aggregates remain the fallback so the app behaves exactly as before until
// Alpaca keys are added.
const hasPrices = hasAlpaca || hasPolygon;
// Any live source at all — used to decide whether the popularity card is real
// data ("live") or the deterministic demo mock ("sample"/"Illustrative").
const hasAnyLive = hasAlpaca || hasPolygon || hasFinnhub || hasAstra;
// A source of headlines for the request path: the Astra store (stored articles)
// or a live Alpaca cold fetch. With neither, the news panel is the demo mock.
const hasNewsSource = hasAstra || hasAlpaca;
import {
  sanitizeTicker,
  summarizeNews,
  mockNewsSummary,
  latestNewsTimestamp,
  windowNews,
  dedupeNews,
  buildPopularitySeries,
  computePopularityScore,
  POPULARITY_WINDOW_DAYS,
} from "./transforms";
import { ANALYSIS_TTL_DAYS } from "./analysis";
import { fetchAlpacaNews } from "./news-loaders";
import {
  getCandlesCached,
  getIntradayCached,
  getFineCached,
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getTickerDetailCached,
  readStoredArticlesCached,
  readAnalysisDocCached,
} from "./cache";

// The background priority lane is fired by the ACTION/PAGE layer (which owns
// after()/revalidateTag — see src/app/details/[id]/priority.ts). getDetailsData
// only decides WHETHER to fire it (cold ticker) and reflects the result in the
// status; the caller supplies this trigger, which returns true when a run was
// actually dispatched. Left undefined (cron warm-ups, ops scripts) no lane runs.
export type PriorityTrigger = (ticker: string) => Promise<boolean>;

export type CandleData = {
  chart_data: BarPoint[];
  stock_price: number;
  price_change: number;
  percent_change: number;
  latest_volume?: number | null;
};

// Live mode returns null on failure — the page then renders an honest
// "price unavailable" placeholder instead of a mock chart masquerading as a
// real one. Mock candles exist only for the demo build.
export async function getStockCandles(ticker: string): Promise<CandleData | null> {
  if (!hasPrices) return generateMockStockData(ticker);
  try {
    return await getCandlesCached(ticker);
  } catch (error) {
    console.error("Candles fetch failed:", error);
    return null;
  }
}

// In live mode a failed range fetch returns [] — the chart then keeps showing
// the REAL daily series for that range instead of swapping in a fake hi-res
// one. Mock series exist only for the zero-provider demo mode, where the whole
// product is explicitly illustrative.
export async function getIntraday(ticker: string): Promise<BarPoint[]> {
  if (!hasPrices) return generateMockIntraday(ticker);
  try {
    const cached = await getIntradayCached(ticker);
    if (cached && cached.length >= 2) return cached;
  } catch (error) {
    console.error("Intraday fetch failed:", error);
  }
  return [];
}

// The 1W series is a pure slice of the fine (15-min, ~96-day) series — same
// resolution, same source — so it costs zero extra requests. Volume/trades ride
// along on each BarPoint so the popularity activity chart works at this range.
const WEEK_SLICE_DAYS = 8;

export function sliceRecentDays(series: BarPoint[], days: number): BarPoint[] {
  if (series.length < 2) return series;
  const latest = Date.parse(series[series.length - 1].date);
  const cutoff = latest - days * 24 * 60 * 60 * 1000;
  const recent = series.filter((p) => Date.parse(p.date) >= cutoff);
  return recent.length >= 2 ? recent : series;
}

export function weekFromFine(fine: BarPoint[]): BarPoint[] {
  return fine.length >= 2 ? sliceRecentDays(fine, WEEK_SLICE_DAYS) : [];
}

export async function getWeek(ticker: string): Promise<BarPoint[]> {
  if (!hasPrices) return generateMockWeek(ticker);
  return weekFromFine(await getFine(ticker));
}

export async function getFine(ticker: string): Promise<BarPoint[]> {
  if (!hasPrices) return generateMockFine(ticker);
  try {
    const cached = await getFineCached(ticker);
    if (cached && cached.length >= 2) return cached;
  } catch (error) {
    console.error("Fine (15m) fetch failed:", error);
  }
  return [];
}

// ─── Store-first news reads (redesign §5/§8) ─────────────────────────────────
// The request path reads stored articles + the verdict doc THROUGH cache.ts's
// named unstable_cache wrappers and never calls a provider for news. Both are
// wrapped so a transient store outage renders an empty/"unavailable" panel
// rather than throwing the whole page (the zero-provider demo also relies on
// these short-circuiting to [] / null).
async function fetchStoredArticles(ticker: string): Promise<StoredArticle[]> {
  if (!hasAstra) return [];
  try {
    return await readStoredArticlesCached(ticker);
  } catch (error) {
    console.error("Astra stored-article read failed:", error);
    return [];
  }
}

async function fetchAnalysisDoc(ticker: string): Promise<AnalysisDoc | null> {
  if (!hasAstra) return null;
  try {
    return await readAnalysisDocCached(ticker);
  } catch (error) {
    console.error("Astra analysis-doc read failed:", error);
    return null;
  }
}

// Pure fetch+map, no writes — safe on the hot path. A cold ticker shows these
// live Benzinga headlines immediately while the priority lane loads real news.
async function fetchColdAlpacaNews(ticker: string): Promise<News[]> {
  try {
    return await fetchAlpacaNews(ticker);
  } catch (error) {
    console.error("Alpaca cold news fetch failed:", error);
    return [];
  }
}

// ─── The request-path status contract (redesign §5/§11, D6/D14) ──────────────
// Pure: given a ticker's article rows, its analysis verdict, and whether a
// priority run was just dispatched, produce the sentiment summary + status the
// UI renders. The gauge aggregates the SAME per-article labels via summarizeNews
// (Polygon-interim or AI depending on label_source — D6 by design). Staleness is
// judged from analyzed_at ONLY (D14), never from article dates.
export function buildNewsSummary(
  articles: News[],
  analysisDoc: AnalysisDoc | null,
  priorityStarted: boolean,
  now: number = Date.now()
): NewsSummary {
  if (articles.length > 0) {
    const analyzedAt = analysisDoc?.analyzed_at;
    // What the recency copy shows: analysis time first, then the last article
    // load, then (legacy rows only) the newest article timestamp.
    const updatedAt =
      analyzedAt ?? analysisDoc?.news_loaded_at ?? latestNewsTimestamp(articles);
    const recent = windowNews(articles, POPULARITY_WINDOW_DAYS, now);
    if (analyzedAt) {
      const analyzedMs = Date.parse(analyzedAt);
      const fresh =
        !Number.isNaN(analyzedMs) &&
        now - analyzedMs <= ANALYSIS_TTL_DAYS * DAY_MS;
      return summarizeNews(recent, fresh ? "fresh" : "stale", updatedAt);
    }
    // Articles present but never deep-analyzed (interim provider/Alpaca labels):
    // "stale" would be dishonest (nothing was analyzed) and "analyzing" a lie
    // when nothing is running, so use "live" — the status provider-labeled
    // headlines already carry.
    return summarizeNews(recent, "live", updatedAt);
  }
  // No stored articles. "analyzing" ONLY when a priority run is genuinely in
  // flight; otherwise an honest empty "unavailable" panel (no retry storm).
  return summarizeNews([], priorityStarted ? "analyzing" : "unavailable");
}

// Builds the popularity/social card from the SAME article set the sentiment
// panel uses (stored rows, or Alpaca cold headlines): the trend from dated,
// sentiment-tagged news and the volume stat from the candles the caller already
// fetched — zero extra requests. Falls back to the deterministic mock (status
// "sample" → the "Illustrative" badge) only in the zero-provider demo build.
function buildPopularityData(
  ticker: string,
  articles: News[],
  latestVolume?: number | null
): PopularityData {
  if (!hasAnyLive) {
    const mock = generateMockPopularity(ticker);
    return {
      popularityRate: mock.popularityRate,
      searchVolume: mock.searchVolume,
      series: mock.series,
      status: "sample",
    };
  }

  const searchVolume =
    typeof latestVolume === "number" && latestVolume > 0 ? latestVolume : 0;
  const deduped = dedupeNews(articles);
  return {
    popularityRate: computePopularityScore(deduped),
    searchVolume,
    series: buildPopularitySeries(deduped),
    status: "live",
  };
}

export function buildStockData(
  symbol: string,
  stock_data: CandleData | null,
  priceStatus: StockData["priceStatus"],
  intradayData: { date: string; value: number }[] | undefined,
  weekData: { date: string; value: number }[] | undefined,
  fineData: { date: string; value: number }[] | undefined,
  news: NewsSummary,
  popularity?: PopularityData
): StockData {
  const pop: PopularityData = popularity ?? {
    ...generateMockPopularity(symbol),
    status: "sample",
  };
  return {
    id: symbol,
    companyName: symbol,
    stockPrice: stock_data?.stock_price,
    priceChange: stock_data?.price_change ?? 0,
    percentChange: stock_data?.percent_change ?? 0,
    priceStatus,
    popularityRate: pop.popularityRate,
    mentions: news.mentions,
    searchVolume: pop.searchVolume,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    popularitySeries: pop.series,
    popularityStatus: pop.status,
    chartData: stock_data?.chart_data ?? [],
    intradayData,
    weekData,
    fineData,
    news: news.news,
    newsStatus: news.status,
    newsUpdatedAt: news.updatedAt,
  };
}

export async function getDetailsData(
  ticker: string,
  triggerPriority?: PriorityTrigger
): Promise<StockData> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) {
    return buildStockData(
      "N/A",
      generateMockStockData("N/A"),
      "sample",
      undefined,
      undefined,
      undefined,
      mockNewsSummary("N/A")
    );
  }

  // Store-first: candles, the stored article rows, and the verdict doc, all in
  // parallel. The news reads go through unstable_cache; NO provider news call
  // happens on this path — the cron owns refresh (D5). Never call Polygon here.
  const [stock_data, storedArticles, analysisDoc] = await Promise.all([
    getStockCandles(symbol),
    fetchStoredArticles(symbol),
    fetchAnalysisDoc(symbol),
  ]);

  const priceStatus: StockData["priceStatus"] = !hasPrices
    ? "sample"
    : stock_data
      ? "live"
      : "unavailable";
  const latestVolume: number | null =
    stock_data && typeof stock_data.latest_volume === "number"
      ? stock_data.latest_volume
      : null;

  let news: NewsSummary;
  let popularityArticles: News[];

  if (!hasNewsSource) {
    // Zero-provider demo build: keep the deterministic mock (status "sample").
    news = summarizeNews(generateMockNews(symbol), "sample");
    popularityArticles = [];
  } else if (storedArticles.length > 0) {
    news = buildNewsSummary(storedArticles, analysisDoc, false);
    popularityArticles = storedArticles;
  } else {
    // Cold ticker: show Alpaca headlines immediately (honest neutral gauge) and
    // fire the priority lane so real news is loaded + analyzed in the
    // background. The response never blocks on any of that.
    const alpaca = hasAlpaca ? await fetchColdAlpacaNews(symbol) : [];
    const priorityStarted = triggerPriority
      ? await triggerPriority(symbol)
      : false;
    news = buildNewsSummary(alpaca, null, priorityStarted);
    popularityArticles = alpaca;
  }

  const popularity = buildPopularityData(symbol, popularityArticles, latestVolume);

  return buildStockData(
    symbol,
    stock_data,
    priceStatus,
    undefined,
    undefined,
    undefined,
    news,
    popularity
  );
}

export async function getChartRangeData(
  ticker: string,
  kind: "daily" | "intraday" | "week" | "fine"
): Promise<BarPoint[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return [];

  switch (kind) {
    case "daily": {
      const data = await getStockCandles(symbol);
      return data?.chart_data ?? [];
    }
    case "intraday":
      return getIntraday(symbol);
    case "week":
      return getWeek(symbol);
    case "fine":
      return getFine(symbol);
  }
}

// Best-effort cache warming for cron — pure reads only, no ingestion side effects.
export async function warmMarketCaches(): Promise<void> {
  if (!hasPrices) return;
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
  if (hasPrices) {
    tasks.push(getStockCandles(symbol));
  }
  // Profile is served by Finnhub (preferred) or Polygon.
  if (hasFinnhub || hasPolygon) {
    tasks.push(getTickerDetailCached(symbol));
  }
  // Warm the store READ caches the details news panel serves from (no writes).
  if (hasAstra) {
    tasks.push(readStoredArticlesCached(symbol));
    tasks.push(readAnalysisDocCached(symbol));
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

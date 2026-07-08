import "server-only";

import { after } from "next/server";
import type { StockData } from "@/app/details/[id]/page";
import {
  generateMockStockData,
  generateMockIntraday,
  generateMockWeek,
  generateMockFine,
  generateMockNews,
  generateMockPopularity,
} from "@/data/fallbacks";
import {
  hasAstra,
  hasAlpaca,
  hasFinnhub,
  hasPolygon,
  hasLangflowIngest,
} from "@/lib/config";
import { claimIngestSlot, ingestTickerNews } from "@/lib/news-ingest";
import type { News } from "@/components/news/RecentInfluential";
import type { NewsSummary, PopularityData, BarPoint } from "./types";

// Any provider that yields real price bars. Alpaca is preferred; Polygon
// aggregates remain the fallback so the app behaves exactly as before until
// Alpaca keys are added.
const hasPrices = hasAlpaca || hasPolygon;
// Any live source at all — used to decide whether the popularity card is real
// data ("live") or the deterministic demo mock ("sample"/"Illustrative").
const hasAnyLive = hasAlpaca || hasPolygon || hasFinnhub || hasAstra;
import {
  sanitizeTicker,
  summarizeNews,
  mockNewsSummary,
  latestNewsTimestamp,
  isNewsStale,
  windowNews,
  dedupeNews,
  buildPopularitySeries,
  computePopularityScore,
} from "./transforms";
import {
  getCandlesCached,
  getIntradayCached,
  getFineCached,
  getNewsCached,
  getTickerNewsCached,
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getTickerDetailCached,
} from "./cache";

export type CandleData = {
  chart_data: BarPoint[];
  stock_price: number;
  price_change: number;
  percent_change: number;
  latest_volume?: number | null;
};

// Live mode returns null on failure — the page then renders an honest
// "price unavailable" placeholder (and re-polls) instead of a mock chart
// masquerading as a real one. Mock candles exist only for the demo build.
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

// The headline panel shows only the newest items; the gauge/mentions still
// count the full 90-day population so they agree with the popularity card.
const HEADLINE_LIMIT = 12;

async function fetchAstraNews(ticker: string): Promise<News[]> {
  if (!hasAstra) return [];
  try {
    return await getNewsCached(ticker);
  } catch (error) {
    console.error("Astra DB news fetch failed:", error);
    return [];
  }
}

async function fetchPolygonNews(ticker: string): Promise<News[]> {
  if (!hasPolygon) return [];
  try {
    return await getTickerNewsCached(ticker);
  } catch (error) {
    console.error("Polygon news fetch failed:", error);
    return [];
  }
}

async function buildNewsSummary(
  ticker: string,
  astraNews: News[],
  polygonNews: News[]
): Promise<NewsSummary> {
  if (astraNews.length > 0) {
    // Freshness is about the newest article overall, so derive updatedAt /
    // staleness from the FULL all-time set BEFORE windowing — a ticker whose
    // latest story is (say) 17 days old must still report that timestamp and
    // stale badge even though the gauge below only counts the last 90 days.
    const updatedAt = latestNewsTimestamp(astraNews);
    const stale = isNewsStale(updatedAt);
    const recent = windowNews(astraNews);
    // Past the 7-day TTL: keep serving the existing analysis but kick off a
    // background re-ingest and mark it "analyzing" so the client polls for the
    // refreshed version (stale-while-revalidate). If ingestion isn't configured
    // or the ticker is in an ingest cooldown (6h after success, 10min after a
    // failed attempt), no job runs — so we honestly label the data "stale".
    if (stale) {
      const refreshing = await scheduleNewsIngestion(ticker);
      return summarizeNews(recent, refreshing ? "analyzing" : "stale", updatedAt);
    }
    return summarizeNews(recent, "fresh", updatedAt);
  }

  const analyzing = hasAstra ? await scheduleNewsIngestion(ticker) : false;

  if (polygonNews.length > 0) {
    const summary = summarizeNews(polygonNews, analyzing ? "analyzing" : "live");
    return { ...summary, news: summary.news.slice(0, HEADLINE_LIMIT) };
  }

  // Mock headlines exist ONLY for the zero-provider demo build. In live mode a
  // total news failure is reported honestly as "unavailable" (empty panel with
  // a retry note) — an end user must never be shown fabricated headlines.
  if (!hasPolygon && !hasAstra) {
    return summarizeNews(generateMockNews(ticker), "sample");
  }
  return summarizeNews([], analyzing ? "analyzing" : "unavailable");
}

export async function scheduleNewsIngestion(ticker: string): Promise<boolean> {
  if (!hasLangflowIngest) return false;
  // Claim the ingest slot BEFORE reporting "analyzing". Otherwise every visit
  // within a cooldown claims an analysis is running when the ingest job would
  // instantly bail on the rate limit, and the UI's "Updating..." promise is
  // broken.
  if (!(await claimIngestSlot(ticker))) return false;
  after(() => ingestTickerNews(ticker, { skipRateLimit: true }));
  return true;
}

// Builds the popularity/social card from the SAME news arrays the sentiment
// panel uses (fetched once by getDetailsData): the trend from dated,
// sentiment-tagged news (Astra unioned with the 90-day Polygon pull) and the
// volume stat from the candles the caller already fetched — zero extra Polygon
// requests. Falls back to the deterministic mock (status "sample" → the
// "Illustrative" badge) only in the zero-provider demo build.
function buildPopularityData(
  ticker: string,
  astraNews: News[],
  polygonNews: News[],
  latestVolume?: number | null
): PopularityData {
  // "sample" (the "Illustrative" badge) only in the true zero-provider demo
  // build. With ANY live source the gauge/score/mentions are real news-derived
  // numbers and the activity chart is backed by real bars.
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
  const deduped = dedupeNews([...astraNews, ...polygonNews]);
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

export async function getDetailsData(ticker: string): Promise<StockData> {
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

  // Resolve candles first so the latest daily volume can seed the popularity
  // card without a second Polygon round-trip.
  const stock_data = await getStockCandles(symbol);
  const priceStatus: StockData["priceStatus"] = !hasPrices
    ? "sample"
    : stock_data
      ? "live"
      : "unavailable";
  const latestVolume: number | null =
    stock_data && typeof stock_data.latest_volume === "number"
      ? stock_data.latest_volume
      : null;

  // Fetch each news source exactly once and derive BOTH the sentiment panel
  // and the popularity card from the same arrays — one Polygon news request
  // per ticker per cache window, and the two views can never disagree.
  const [astraNews, polygonNews] = await Promise.all([
    fetchAstraNews(symbol),
    fetchPolygonNews(symbol),
  ]);
  const news = await buildNewsSummary(symbol, astraNews, polygonNews);
  const popularity = buildPopularityData(
    symbol,
    astraNews,
    polygonNews,
    latestVolume
  );

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
  // Warm the Astra READ cache only (no ingestion side effect).
  if (hasAstra) {
    tasks.push(getNewsCached(symbol));
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

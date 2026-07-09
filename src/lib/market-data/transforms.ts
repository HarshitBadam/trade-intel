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
  PopularitySeriesPoint,
  BarPoint,
  LiveQuote,
  ActivitySeries,
  ActivityPoint,
  ActivityMarker,
} from "./types";
import type { AlpacaBar, AlpacaSnapshot } from "./alpaca";

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

// ─── Provider bar/snapshot mappers ──────────────────────────────────────────
// All price bars converge on the shared `BarPoint` shape: `value` is the close
// (so MainChart is untouched) plus optional `volume`/`trades` for the activity
// chart. Both Alpaca and Polygon aggregates carry `v` (volume) and `n` (trade
// count), so the dense popularity fix works on either provider path.

export function mapAlpacaBars(bars: AlpacaBar[]): BarPoint[] {
  return bars
    .map((b) => ({
      date: new Date(b.t).toISOString(),
      value: b.c,
      volume: typeof b.v === "number" ? b.v : undefined,
      trades: typeof b.n === "number" ? b.n : undefined,
    }))
    .filter((p) => Number.isFinite(p.value) && !Number.isNaN(Date.parse(p.date)));
}

export type PolygonAggBar = {
  t: number;
  c: number;
  o?: number;
  v?: number;
  n?: number;
};

export function mapPolygonAggs(results: PolygonAggBar[]): BarPoint[] {
  return results
    .map((b) => ({
      date: new Date(b.t).toISOString(),
      value: b.c,
      volume: typeof b.v === "number" ? b.v : undefined,
      trades: typeof b.n === "number" ? b.n : undefined,
    }))
    .filter((p) => Number.isFinite(p.value) && !Number.isNaN(Date.parse(p.date)));
}

// Derives a live quote from an Alpaca snapshot: price is the latest trade (or
// today's close), day change is measured against the previous daily close, and
// volume is today's share volume. Returns null when the essentials are missing
// so a card never renders an invented price.
export function mapAlpacaSnapshotQuote(
  ticker: string,
  snap: AlpacaSnapshot | undefined
): LiveQuote | null {
  if (!snap) return null;
  const price = snap.latestTrade?.p ?? snap.dailyBar?.c;
  const prevClose = snap.prevDailyBar?.c;
  if (typeof price !== "number" || price <= 0) return null;
  if (typeof prevClose !== "number" || prevClose <= 0) return null;
  const change = price - prevClose;
  return {
    ticker,
    price,
    change,
    percentChange: (change / prevClose) * 100,
    volume: typeof snap.dailyBar?.v === "number" ? snap.dailyBar.v : 0,
  };
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

// Popularity trend spans ~90 days, bucketed daily to match the granularity of
// the price chart. Daily is the finest resolution the data supports, since news
// `publication_date` is date-only (no intraday timestamp).
export const POPULARITY_WINDOW_DAYS = 90;
const POPULARITY_BUCKET_DAYS = 1;

function articleTime(n: News): number {
  const raw = n.metadata.publication_date || n.metadata.ingested_at;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

// Keep only the articles inside the popularity trend's window so the sentiment
// gauge + mentions count the SAME population as the popularity score/chart
// (which use buildPopularitySeries/computePopularityScore) instead of the full
// all-time Astra set. Same publication_date || ingested_at rule via articleTime.
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

// De-duplicate articles that appear in both Astra and Polygon (same story),
// preferring a real URL as the identity, then the doc id, then the title.
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

// Bucket real news into a continuous positive/negative weekly series. Empty
// buckets are pre-seeded so the area chart stays continuous across quiet weeks.
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

// ─── Dense market-activity series (redesigned popularity chart) ─────────────
// Reuses the SAME price bars the chart already fetched (zero extra API calls):
// Y is per-bar trading activity (trade count `n` preferred, else volume `v`),
// which gives 50+ points at any range and enables 1D + all wider ranges. The
// area is TINTED by the prevailing, forward-filled net news sentiment as of each
// bar, and days that news broke get a sentiment-colored marker. This is an
// established investor-attention proxy (Barber & Odean 2008) — framed honestly
// as "market activity + sentiment", never as search popularity. The gauge /
// breakdown / popularity score stay news-derived and unchanged.

// Days of news that feed each bar's "prevailing" tint. A trailing window (rather
// than a single day) keeps the tint stable instead of flipping on one article.
const SENTIMENT_TRAIL_DAYS = 21;
// Cap markers so a busy 90-day window doesn't clutter the line.
const MAX_ACTIVITY_MARKERS = 40;

function sentimentValue(n: News): number {
  const s = n.metadata.sentiment;
  if (s === "Positive") return 1;
  if (s === "Negative") return -1;
  return 0;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildActivitySeries(
  bars: BarPoint[],
  news: News[]
): ActivitySeries {
  const sorted = [...bars]
    .map((b) => ({
      t: typeof b.date === "number" ? b.date : Date.parse(b.date),
      activity: b.trades ?? b.volume ?? 0,
      hasTrades: typeof b.trades === "number",
    }))
    .filter((b) => !Number.isNaN(b.t))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 0) {
    return { points: [], markers: [], metric: "volume" };
  }

  const metric: "trades" | "volume" = sorted.some((b) => b.hasTrades)
    ? "trades"
    : "volume";
  const firstT = sorted[0].t;
  const lastT = sorted[sorted.length - 1].t;

  // News events (with a +1/-1/0 sentiment) sorted by time — used both for the
  // trailing-window tint and the per-day markers.
  const events = news
    .map((n) => {
      const raw = n.metadata.publication_date || n.metadata.ingested_at;
      const t = raw ? Date.parse(raw) : NaN;
      return { t, s: sentimentValue(n) };
    })
    .filter((e) => !Number.isNaN(e.t))
    .sort((a, b) => a.t - b.t);

  // Prevailing net sentiment via a two-pointer trailing window, forward-filled
  // (carry the last non-empty value; start neutral at 0 before any news).
  const trailMs = SENTIMENT_TRAIL_DAYS * 24 * 60 * 60 * 1000;
  let lo = 0;
  let hi = 0;
  let pos = 0;
  let neg = 0;
  let carried = 0;
  const points: ActivityPoint[] = sorted.map((bar) => {
    while (hi < events.length && events[hi].t <= bar.t) {
      if (events[hi].s > 0) pos++;
      else if (events[hi].s < 0) neg++;
      hi++;
    }
    const minT = bar.t - trailMs;
    while (lo < hi && events[lo].t < minT) {
      if (events[lo].s > 0) pos--;
      else if (events[lo].s < 0) neg--;
      lo++;
    }
    const pn = pos + neg;
    if (pn > 0) carried = (pos - neg) / pn;
    return { date: bar.t, activity: bar.activity, sentiment: carried };
  });

  // Markers: one per calendar day within the visible range that had news,
  // colored by that day's own net sentiment, anchored to the matching bar.
  const dayAgg = new Map<string, { pos: number; neg: number }>();
  for (const e of events) {
    if (e.t < firstT - 24 * 60 * 60 * 1000 || e.t > lastT) continue;
    const key = dayKey(e.t);
    const agg = dayAgg.get(key) ?? { pos: 0, neg: 0 };
    if (e.s > 0) agg.pos++;
    else if (e.s < 0) agg.neg++;
    dayAgg.set(key, agg);
  }

  const markers: ActivityMarker[] = [];
  for (const [key, agg] of dayAgg) {
    // Prefer the last bar on that day; otherwise the first bar after it.
    let anchor = points.find((p) => dayKey(p.date) === key);
    if (anchor) {
      for (const p of points) if (dayKey(p.date) === key) anchor = p;
    } else {
      const dayStart = Date.parse(`${key}T00:00:00.000Z`);
      anchor = points.find((p) => p.date >= dayStart);
    }
    if (!anchor) continue;
    const pn = agg.pos + agg.neg;
    markers.push({
      date: anchor.date,
      activity: anchor.activity,
      sentiment: pn > 0 ? (agg.pos - agg.neg) / pn : 0,
    });
  }
  // Keep the most recent markers when there are many.
  markers.sort((a, b) => a.date - b.date);
  const trimmed =
    markers.length > MAX_ACTIVITY_MARKERS
      ? markers.slice(markers.length - MAX_ACTIVITY_MARKERS)
      : markers;

  return { points, markers: trimmed, metric };
}

// Real 0-100 popularity score: blends how positive coverage is (net sentiment)
// with how much coverage there is (attention). The attention term saturates so
// a few articles already register without volume dominating the score.
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
  const attentionScore = (1 - Math.exp(-total / 12)) * 100;
  return Math.round(0.6 * sentimentScore + 0.4 * attentionScore);
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

// ---------------------------------------------------------------------------
// Related-stock "Key Reason" engine
// ---------------------------------------------------------------------------
// The card title already states the selection axis (industry / return / size),
// so a reason like "Retail sector" is redundant and reads bland. Instead we
// derive the single most *notable, true, relational* observation about a peer
// versus the stock in view — comparing them across every dimension we already
// fetched (no extra API calls) and, when a second dimension is genuinely
// notable, composing the two. Everything is deterministic and grounded in real
// numbers: same inputs always yield the same reason, and the weakest fallback
// is still a real fact ("+1.2% today on 4.3M shares"), never invented filler.

export type RelationStats = {
  ticker: string;
  price: number | null;
  pct: number | null;
  ret1y: number | null;
  volume: number | null;
  marketCap: number | null;
  sector: string | null;
};

// The lens a given card is selected on — used only to *bias* which insight we
// surface, never to restrict it, so a "Similar Industry" card can still lead
// with a divergence insight when that is the more interesting truth.
export type InsightLens = "industry" | "return" | "size";

type InsightGroup = "return" | "scale" | "flow" | "context";
type InsightCandidate = {
  kind: string;
  group: InsightGroup;
  salience: number;
  text: string;
};

function pctProse(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function clamp01(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Every candidate observation that is *true* for this (subject, peer) pair,
// each tagged with a salience in [0,1] reflecting how noteworthy it is. The
// selector below picks the best, so ordering here does not matter.
function relationCandidates(
  subject: RelationStats,
  peer: RelationStats
): InsightCandidate[] {
  const out: InsightCandidate[] = [];
  const sym = subject.ticker;
  const sameSector =
    !!subject.sector &&
    !!peer.sector &&
    subject.sector.trim().toLowerCase() === peer.sector.trim().toLowerCase();

  // --- Trailing 1-year performance (the richest relational signal) ---------
  if (subject.ret1y != null && peer.ret1y != null) {
    const gap = peer.ret1y - subject.ret1y;
    const absGap = Math.abs(gap);
    if (sameSector && absGap >= 12) {
      out.push({
        kind: "sector-divergence",
        group: "return",
        salience: clamp01(0.6 + absGap / 120, 0, 0.95),
        text: `${titleCase(peer.sector!)} peer, ${pctProse(
          peer.ret1y
        )} vs ${sym} ${pctProse(subject.ret1y)} this year`,
      });
    } else if (sameSector) {
      out.push({
        kind: "sector-tandem",
        group: "return",
        salience: 0.55,
        text: `${titleCase(peer.sector!)} peer moving with ${sym}, ${pctProse(
          peer.ret1y
        )} vs ${pctProse(subject.ret1y)}`,
      });
    }
    if (absGap >= 8) {
      const lead = gap > 0 ? "Outpacing" : "Lagging";
      out.push({
        kind: "perf-gap",
        group: "return",
        salience: clamp01(0.5 + absGap / 130, 0, 0.82),
        text: `${lead} ${sym} by ${Math.round(absGap)} points this year`,
      });
    }
  }

  // --- Relative scale (market cap) -----------------------------------------
  if (
    subject.marketCap &&
    peer.marketCap &&
    subject.marketCap > 0 &&
    peer.marketCap > 0
  ) {
    const r = peer.marketCap / subject.marketCap;
    if (r >= 1.8) {
      const mult = r >= 10 ? `${Math.round(r)}\u00d7` : `${r.toFixed(1)}\u00d7`;
      out.push({
        kind: "scale",
        group: "scale",
        salience: clamp01(0.42 + Math.log(r) / Math.log(50), 0, 0.85),
        text: `Worth about ${mult} ${sym} at ${formatMarketCap(
          peer.marketCap
        )}`,
      });
    } else if (r <= 0.55) {
      const inv = 1 / r;
      const mult =
        inv >= 10 ? `${Math.round(inv)}\u00d7` : `${inv.toFixed(1)}\u00d7`;
      out.push({
        kind: "scale",
        group: "scale",
        salience: clamp01(0.42 + Math.log(inv) / Math.log(50), 0, 0.85),
        text: `About ${mult} smaller than ${sym} at ${formatMarketCap(
          peer.marketCap
        )}`,
      });
    } else {
      out.push({
        kind: "scale-peer",
        group: "scale",
        salience: 0.34,
        text: `Similar size to ${sym} at ${formatMarketCap(peer.marketCap)}`,
      });
    }
  }

  // --- Today's session (co-move vs divergence) -----------------------------
  // Kept low: the card already shows the peer's daily % move, so this is only a
  // last resort when the value-add signals (1Y, sector, cap) are unavailable.
  if (subject.pct != null && peer.pct != null) {
    const opposite = Math.sign(peer.pct) !== Math.sign(subject.pct);
    if (opposite && Math.abs(peer.pct) >= 0.4 && Math.abs(subject.pct) >= 0.4) {
      out.push({
        kind: "session",
        group: "flow",
        salience: clamp01(
          0.2 + (Math.abs(peer.pct) + Math.abs(subject.pct)) / 40,
          0,
          0.4
        ),
        text: `Moving opposite ${sym} today, ${pctProse(
          peer.pct
        )} vs ${pctProse(subject.pct)}`,
      });
    } else if (
      !opposite &&
      Math.abs(peer.pct) >= 1 &&
      Math.abs(subject.pct) >= 1
    ) {
      out.push({
        kind: "session",
        group: "flow",
        salience: clamp01(
          0.18 + (Math.abs(peer.pct) + Math.abs(subject.pct)) / 45,
          0,
          0.36
        ),
        text: `Moving with ${sym} today, ${pctProse(peer.pct)} vs ${pctProse(
          subject.pct
        )}`,
      });
    }
  }

  // --- Relative liquidity (also shown on the card as volume, so low) --------
  if (subject.volume && peer.volume && subject.volume > 0 && peer.volume > 0) {
    const r = peer.volume / subject.volume;
    if (r >= 3) {
      out.push({
        kind: "liquidity",
        group: "flow",
        salience: 0.28,
        text: `Trading about ${
          r >= 10 ? Math.round(r) : r.toFixed(1)
        }\u00d7 ${sym}'s volume today`,
      });
    } else if (r <= 1 / 3) {
      out.push({
        kind: "liquidity",
        group: "flow",
        salience: 0.24,
        text: `Lighter volume than ${sym} today`,
      });
    }
  }

  // --- Context fallbacks: always a real fact, never invented filler --------
  if (peer.sector) {
    out.push({
      kind: "sector-fact",
      group: "context",
      salience: 0.25,
      text: `${titleCase(peer.sector)} peer of ${sym}`,
    });
  }
  if (peer.pct != null && peer.volume != null) {
    out.push({
      kind: "anchor",
      group: "context",
      salience: 0.1,
      text: `${pctProse(peer.pct)} today on ${formatVolume(
        peer.volume
      )} shares`,
    });
  } else if (peer.price != null) {
    out.push({
      kind: "anchor",
      group: "context",
      salience: 0.1,
      text: `Trading at $${peer.price.toFixed(2)} alongside ${sym}`,
    });
  }

  return out;
}

const LENS_BOOST: Record<InsightLens, Set<string>> = {
  industry: new Set(["sector-divergence", "sector-tandem", "sector-fact"]),
  return: new Set(["perf-gap", "sector-divergence", "session"]),
  size: new Set(["scale", "scale-peer", "liquidity"]),
};

// Picks the single sharpest reason for one card, kept to a short scannable
// phrase (a card is a glanceable unit, not a paragraph). `used` is shared across
// the trio so the three cards never repeat the same angle: each consumes its
// chosen dimension, pushing the next card toward a different, still-notable one.
export function buildRelationInsight(
  subject: RelationStats,
  peer: RelationStats,
  lens: InsightLens,
  used: Set<string>
): string {
  const boost = LENS_BOOST[lens];
  const scored = relationCandidates(subject, peer)
    .map((c) => ({
      ...c,
      score: c.salience + (boost.has(c.kind) ? 0.25 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return `Peer of ${subject.ticker}`;

  const primary = scored.find((c) => !used.has(c.kind)) ?? scored[0];
  used.add(primary.kind);
  return primary.text;
}

// Requires a live quote by type: related cards render real prices or they
// don't render at all — a peer must never be shown with invented numbers.
export function relatedData(
  c: Candidate & { quote: NonNullable<Candidate["quote"]> },
  reason: string
): RelatedStock {
  const pct = c.quote.percentChange;
  const up = pct >= 0;
  const sign = up ? "+" : "";

  return {
    ticker: c.ticker,
    name: c.name,
    currentPrice: `$${c.quote.price.toFixed(2)}`,
    priceChange: `${sign}${c.quote.change.toFixed(2)}`,
    percentageChange: `${sign}${pct.toFixed(2)}%`,
    volume: formatVolume(c.quote.volume),
    sentiment: up ? "Bullish" : "Bearish",
    sentimentSource: [moveStrength(pct)],
    reason,
  };
}

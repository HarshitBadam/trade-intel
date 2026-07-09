// Shared market-data DTOs.
//
// These describe the shapes that flow from the server data layer
// (`market-data.ts`, a `server-only` module) out to the `"use server"` action
// wrappers and the client components that render them. They live in their own
// directive-free module on purpose: a `"use server"` file may only export async
// functions, so it cannot re-export types, and client components must not import
// values from a `server-only` module. A neutral types module lets both sides
// share the contract without violating either constraint.

import type { RelatedStock } from "@/data/fallbacks";
import type { News, NewsStatus } from "@/components/news/RecentInfluential";

export type SearchResult = {
  ticker: string;
  name: string;
};

// What searchStocks hands the search UI. `searchUnavailable` is set when the
// live fallback errored AND the local universe had nothing — so the UI can
// say "search is temporarily unavailable" instead of the lie "no stocks
// found". An honestly-empty result (search worked, zero matches) omits it.
export type SearchResponse = {
  stocks: SearchResult[];
  searchUnavailable?: true;
};

// A single chart bar. `value` is the close (what the price line reads, so
// MainChart is untouched). `volume` (shares) and `trades` (count) ride along
// from the provider aggregates and power the dense popularity/activity chart —
// zero extra API calls, since they come free with the same bars.
export type BarPoint = {
  date: string;
  value: number;
  volume?: number;
  trades?: number;
};

export type Quote = {
  ticker: string;
  stockPrice: number;
  priceChange: number;
  percentChange: number;
  chartData: BarPoint[];
  intradayData: BarPoint[];
  weekData: BarPoint[];
  fineData: BarPoint[];
};

export type Headline = {
  ticker: string;
  newsTitle: string;
  newsContent: string;
  source?: string;
  date?: string;
  url?: string;
  sentiment?: string;
};

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

export type LiveQuote = {
  ticker: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
};

// Richer, multi-horizon quote used to ground the StockSage chat. Built from
// per-ticker daily aggregates (the same source the detail page uses), so it is
// reliable for any ticker without depending on the market-wide grouped snapshot.
export type ChatQuote = {
  ticker: string;
  price: number;
  /** latest session change vs the prior close, in percent */
  dayPct: number;
  /** trailing performance, in percent; null when not enough history */
  weekPct: number | null;
  monthPct: number | null;
  yearPct: number | null;
};

export type RelatedCard = { title: string; data: RelatedStock };

export type NewsSummary = {
  mentions: number;
  positiveSentiment: number;
  negativeSentiment: number;
  news: News[];
  status: NewsStatus;
  updatedAt?: string;
};

export type PopularitySeriesPoint = {
  date: string;
  positive: number;
  negative: number;
};

// One point on the dense market-activity chart (the redesigned popularity view).
// `activity` is the per-bar trade count (preferred) or volume; `sentiment` is the
// prevailing, forward-filled net news sentiment as of that bar (-1..1), used to
// TINT the area.
export type ActivityPoint = {
  date: number;
  activity: number;
  sentiment: number;
};

// A day on which news broke, placed as a sentiment-colored marker on the chart.
export type ActivityMarker = {
  date: number;
  activity: number;
  sentiment: number;
};

export type ActivitySeries = {
  points: ActivityPoint[];
  markers: ActivityMarker[];
  /** Whether `activity` is a trade count ("trades") or share volume ("volume"). */
  metric: "trades" | "volume";
};

// Social/popularity payload for the details flip card. `status` is "live" when
// every value is backed by a real source (Polygon volume + Polygon/Astra news)
// and "sample" when we fell back to the deterministic mock (open demo mode).
export type PopularityData = {
  popularityRate: number;
  /** Latest daily trading volume; 0 when no real volume source is available. */
  searchVolume: number;
  series: PopularitySeriesPoint[];
  status: "live" | "sample";
};

export type TickerDetail = {
  ticker: string;
  name: string;
  sicCode: string | null;
  sector: string | null;
  marketCap: number | null;
};

// Who produced the CURRENT per-article sentiment label. "polygon"/"alpaca" are
// interim provider labels written at load time; "ai" means the deep-analysis
// pass has relabeled the row. Lets the analysis cron and diagnosis tools tell
// interim labels from AI ones without guessing.
export type LabelSource = "polygon" | "ai" | "alpaca";

// An article row as the store writes it: the exact `News` shape the reader
// already consumes (so legacy Langflow rows and new loader rows read
// identically) plus the store's own bookkeeping fields. The extras are
// optional because legacy rows predate them; the loaders always set them.
export type StoredArticle = News & {
  metadata: News["metadata"] & {
    /** Stable content id (see stableArticleId); also the doc `_id`. */
    article_id?: string;
    label_source?: LabelSource;
    /** Polygon insights' free-form reasoning for the sentiment label. */
    sentiment_reasoning?: string;
  };
};

export type AnalysisKeyDriver = {
  text: string;
  sentiment: "Positive" | "Negative" | "Neutral";
  /** `metadata.article_id` values of the articles backing this driver. */
  article_ids: string[];
};

// Per-ticker collection-level verdict (redesign §6) stored in the analysis
// collection, one doc per symbol with `_id` = uppercased ticker. The news
// loader only ever stamps `news_loaded_at`; the deep-analysis pass owns the
// rest and writes `analyzed_at` ONLY on success (§11 — staleness is judged
// from it, never from article dates). Everything but the identity is optional
// because the doc exists as soon as either writer touches it.
export type AnalysisDoc = {
  _id?: string;
  ticker: string;
  analyzed_at?: string;
  model?: string;
  /** Number of stored articles the verdict was built on. */
  article_count?: number;
  overall_sentiment?: "Positive" | "Negative" | "Neutral" | "Mixed";
  /** Holistic score, -1..1. */
  sentiment_score?: number;
  confidence?: "High" | "Medium" | "Low";
  summary?: string;
  key_drivers?: AnalysisKeyDriver[];
  risks?: string[];
  source_window_days?: number;
  /** Last successful article load for this ticker (set by the news cron). */
  news_loaded_at?: string;
};

export type Candidate = {
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

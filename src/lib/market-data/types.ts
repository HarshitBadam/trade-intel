import type { RelatedStock } from "@/data/fallbacks";
import type { News, NewsStatus } from "@/components/news/RecentInfluential";

export type SearchResult = {
  ticker: string;
  name: string;
};

export type SearchResponse = {
  stocks: SearchResult[];
  searchUnavailable?: true;
};

// `value` is the close (what the price line reads). `volume` (shares) and
// `trades` (count) come free with the same bars and power the activity chart.
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
// per-ticker daily aggregates so it is reliable for any ticker without depending
// on the market-wide grouped snapshot.
export type ChatQuote = {
  ticker: string;
  price: number;
  asOf: string;
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

export type ActivityPoint = {
  date: number;
  activity: number;
  /** Prevailing net news sentiment tinting this bar (-1..1), forward-filled. */
  sentiment: number;
};

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

// Who produced the current per-article sentiment label. "polygon"/"alpaca" are
// interim provider labels written at load time; "ai" means the deep-analysis
// pass has relabeled the row.
export type LabelSource = "polygon" | "ai" | "alpaca";

// An article row as the store writes it: the exact `News` shape the reader
// already consumes (so legacy Langflow rows and new loader rows read identically)
// plus store bookkeeping fields. The extras are optional because legacy rows
// predate them; the loaders always set them.
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

// Per-ticker collection-level verdict stored in the analysis collection, one doc
// per symbol with `_id` = uppercased ticker. The news loader only stamps
// `news_loaded_at`; the deep-analysis pass owns the rest and writes `analyzed_at`
// ONLY on success — staleness is judged from it, never from article dates.
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

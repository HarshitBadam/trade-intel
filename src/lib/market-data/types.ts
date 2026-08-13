import type { NewsVerdict } from "@/components/news/VerdictModal";

export type News = {
  _id: string;
  page_content: string;
  metadata: {
    title: string;
    source: string;
    publication_date: string;
    importance: string;
    sentiment: string;
    key_observations: string;
    url: string;
    ticker: string;
    description: string;
    event: string;
    ingested_at?: string;
  };
};

export type NewsStatus =
  | "fresh"
  | "analyzing"
  | "live"
  | "sample"
  | "stale"
  | "degraded"
  | "hard_expired"
  | "no_news"
  | "analysis_unavailable"
  | "unavailable";

export type SearchResult = {
  ticker: string;
  name: string;
};

export type SearchResponse = {
  stocks: SearchResult[];
  searchUnavailable?: true;
};

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

export type DataStatus = "live" | "sample";

export type Headline = {
  ticker: string;
  newsTitle: string;
  newsContent: string;
  source?: string;
  date?: string;
  url?: string;
  sentiment?: string;
  status: DataStatus;
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
  status: DataStatus;
};

export type LiveQuote = {
  ticker: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
};

export type ChatIntervalMetric = {
  /** Calendar/start/end identity from the normalized temporal compiler. */
  intervalKey: string;
  startSession: string;
  endSession: string;
  /** First and last candles actually used inside the requested bounds. */
  firstSession: string;
  lastSession: string;
  /** Close at the requested point, or the ending close for a range. */
  price: number;
  /** Return over the point session or bounded range when a baseline exists. */
  returnPct: number | null;
  baselineSession?: string;
};

export type ChatQuote = {
  ticker: string;
  // The instrument that supplied this quote, kept distinct from logical ticker.
  instrumentSymbol?: string;
  venue?: "US" | "ASX" | "INDEX";
  currency?: "USD" | "AUD" | "NONE";
  price: number;
  asOf: string;
  // EOD/delayed series such as Stooq, rather than a near-live feed.
  eod?: boolean;
  // Identifies proxy series such as a US-listed ADR.
  sourceNote?: string;
  // Index level rather than a share price.
  isIndex?: boolean;
  // Separately traded fallback for a market or index without a direct feed.
  proxySymbol?: string;
  proxyKind?: "etf" | "adr";
  dayPct: number;
  prevSessionPct?: number | null;
  prevSessionDate?: string;
  fewDaysPct: number | null;
  weekPct: number | null;
  // Exchange-session returns for explicit calendar periods.
  wtdPct?: number | null;
  lastWeekPct?: number | null;
  monthPct: number | null;
  lastMonthPct?: number | null;
  yearPct: number | null;
  // Calendar year-to-date, measured from the prior year-end close.
  ytdPct?: number | null;
  ytdStart?: string;
  // Calendar month-to-date, distinct from trailing monthPct.
  mtdPct?: number | null;
  mtdStart?: string;
  fewDaysStart?: string;
  weekStart?: string;
  wtdStart?: string;
  lastWeekStart?: string;
  lastWeekEnd?: string;
  monthStart?: string;
  lastMonthStart?: string;
  lastMonthEnd?: string;
  yearStart?: string;
  /** Bounded metrics keyed by normalized market-calendar interval identity. */
  intervalMetrics?: Record<string, ChatIntervalMetric>;
};

export type RelatedStock = {
  ticker: string;
  name: string;
  currentPrice: string;
  priceChange: string;
  percentageChange: string;
  volume: string;
  sentiment: string;
  sentimentSource: string[];
  reason: string;
};

export type RelatedCard = { title: string; data: RelatedStock };

export type NewsSummary = {
  mentions: number;
  positiveSentiment: number;
  negativeSentiment: number;
  news: News[];
  status: NewsStatus;
  updatedAt?: string;
  /** Present when stored analysis has the required verdict fields. */
  verdict?: NewsVerdict;
};

export type PopularitySeriesPoint = {
  date: string;
  positive: number;
  negative: number;
};

export type ActivityPoint = {
  date: number;
  activity: number;
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
  metric: "trades" | "volume";
};

export type PopularityData = {
  popularityRate: number;
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

export type LabelSource = "polygon" | "ai" | "alpaca";

export type StoredArticle = News & {
  metadata: News["metadata"] & {
    article_id?: string;
    label_source?: LabelSource;
    sentiment_reasoning?: string;
  };
};

export type AnalysisKeyDriver = {
  text: string;
  sentiment: "Positive" | "Negative" | "Neutral";
  article_ids: string[];
};

export type AnalysisDoc = {
  _id?: string;
  ticker: string;
  pipeline_version?: string;
  content_fingerprint?: string;
  analysis_fingerprint?: string;
  news_checked_at?: string;
  /** Last successful, atomically published system conclusion. */
  concluded_at?: string;
  last_success_at?: string;
  refresh_requested_at?: string;
  refresh_source?: "showcase_cron" | "user_request" | "manual";
  generation?: number;
  last_error_code?: string;
  published_article_ids?: string[];
  published_article_labels?: {
    article_id: string;
    sentiment: string;
    importance: string;
    key_observations: string;
  }[];
  analysis_status?: "complete" | "unavailable" | "no_news";
  /**
   * Written by the worker immediately before it upserts newly fetched
   * article rows, and cleared by every successful `publishAnalysisDoc` CAS
   * write. While set, a refresh is in flight (or died mid-flight) and any
   * rows newer than this timestamp are staged/unpublished: readers that
   * have no manifest or watermark of their own yet must treat this as an
   * active "fail closed" (or, for readers with a committed-history filter,
   * an upper bound) rather than assume the collection only ever contains
   * genuine legacy data.
   */
  refresh_staging_at?: string;
  analyzed_at?: string;
  model?: string;
  article_count?: number;
  overall_sentiment?: "Positive" | "Negative" | "Neutral" | "Mixed";
  sentiment_score?: number;
  confidence?: "High" | "Medium" | "Low";
  summary?: string;
  key_drivers?: AnalysisKeyDriver[];
  risks?: string[];
  source_window_days?: number;
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

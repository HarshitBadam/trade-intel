import type { RelatedStock } from "@/data/fallbacks";
import type { News, NewsStatus } from "@/components/news/RecentInfluential";
import type { NewsVerdict } from "@/components/news/VerdictModal";

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

// Required so every construction site has to declare whether the payload came
// from a provider or from the seeded mock generators: home-page fallbacks use
// real tickers, so unlabelled sample data is indistinguishable from live.
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

export type ChatQuote = {
  ticker: string;
  price: number;
  asOf: string;
  // True when the series is end-of-day/delayed (e.g. Stooq) rather than a
  // near-live feed — surfaced so answers can label the as-of honestly.
  eod?: boolean;
  // Human note about what the series actually is (e.g. "US-listed ADR, USD")
  // so answers never present a proxy series as the primary listing.
  sourceNote?: string;
  // Index level rather than a share price — rendered in points, not dollars.
  isIndex?: boolean;
  // A separately traded security used when the requested market/index has no
  // reliable direct feed. Renderers must name this symbol and describe its
  // returns as proxy-security returns, never as the requested index's return.
  proxySymbol?: string;
  proxyKind?: "etf" | "adr";
  dayPct: number;
  // Prior completed session's own move (what a user means by "yesterday").
  prevSessionPct?: number | null;
  prevSessionDate?: string;
  fewDaysPct: number | null;
  weekPct: number | null;
  monthPct: number | null;
  yearPct: number | null;
  // Calendar year-to-date, measured from the last close of the prior year
  // (or the earliest session of this year when history is shorter).
  ytdPct?: number | null;
  ytdStart?: string;
  // Calendar month-to-date, measured from the last close of the prior month.
  // Distinct from monthPct (trailing ~21 sessions): "since the start of the
  // month" and "over the last month" are different questions.
  mtdPct?: number | null;
  mtdStart?: string;
  fewDaysStart?: string;
  weekStart?: string;
  monthStart?: string;
  yearStart?: string;
};

export type ChatFundamentals = {
  ticker: string;
  asOf: string;
  peTtm: number | null;
  revenueGrowthTtmYoy: number | null;
  beta: number | null;
  earnings: {
    period: string;
    quarter: number | null;
    year: number | null;
    actualEps: number | null;
    estimatedEps: number | null;
    surprisePercent: number | null;
  } | null;
};

export type RelatedCard = { title: string; data: RelatedStock };

export type NewsSummary = {
  mentions: number;
  positiveSentiment: number;
  negativeSentiment: number;
  news: News[];
  status: NewsStatus;
  updatedAt?: string;
  /** Present only when a stored analysis doc carries a usable verdict. */
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

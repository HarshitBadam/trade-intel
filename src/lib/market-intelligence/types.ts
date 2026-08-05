import type { News, NewsStatus } from "@/components/news/RecentInfluential";
import type { NewsVerdict } from "@/components/news/VerdictModal";
import type { BarPoint } from "@/lib/market-data/types";

export type RefreshSource = "showcase_cron" | "user_request" | "manual";

export type MarketIntelligenceState =
  | "fresh"
  | "stale"
  | "missing"
  | "degraded"
  | "hard_expired"
  | "no_news";

// "backgrounded" is an honest terminal state for the UI's own bounded
// polling window: active polling gave up (~2 minutes of 2s/4s/8s/15s/30s
// backoff) while the durable job may still be queued or running server
// side. It must never be collapsed into "idle", which implies nothing is
// happening.
export type RefreshState =
  | "idle"
  | "queued"
  | "running"
  | "failed"
  | "backgrounded";
export type AnalysisStatus = "complete" | "unavailable" | "no_news";

export type AnalysisRefreshMetadata = {
  pipeline_version?: string;
  content_fingerprint?: string;
  analysis_fingerprint?: string;
  news_checked_at?: string;
  last_success_at?: string;
  refresh_requested_at?: string;
  refresh_source?: RefreshSource;
  generation?: number;
  last_error_code?: string;
};

export type TickerIntelligenceBundle = {
  ticker: string;
  generation: number;
  state: MarketIntelligenceState;
  refreshState: RefreshState;
  publishedArticleIds: string[];
  contentFingerprint?: string;
  analysisFingerprint?: string;
  newsCheckedAt?: string;
  analyzedAt?: string;
  lastSuccessAt?: string;
  analysisStatus?: AnalysisStatus;
  retryAfterSec?: number;
};

export type StockData = {
  id: string;
  companyName: string;
  stockPrice: number | undefined;
  priceChange: number;
  percentChange: number;
  priceStatus: "live" | "sample" | "unavailable";
  popularityRate: number;
  mentions: number;
  searchVolume: number;
  sentimentPercentage: number;
  positiveSentimentPercentage: number;
  negativeSentimentPercentage: number;
  popularitySeries: { date: string; positive: number; negative: number }[];
  popularityStatus: "live" | "sample";
  chartData: BarPoint[];
  intradayData?: BarPoint[];
  weekData?: BarPoint[];
  fineData?: BarPoint[];
  news: News[];
  newsStatus: NewsStatus;
  newsUpdatedAt?: string;
  newsVerdict?: NewsVerdict;
  intelligence: TickerIntelligenceBundle;
};

export type {
  AnalysisDoc,
  AnalysisKeyDriver,
  StoredArticle,
} from "@/lib/market-data/types";

/** Bounded active-polling backoff (2s/4s/8s/15s/30s.../30s), ~2 minutes total. */
export const POLL_DELAYS_MS = [
  2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
];

/**
 * Converts an absolute retryAfter ISO timestamp into a whole-second
 * countdown relative to `now`. Returns undefined when there's nothing
 * actionable to show (missing/invalid/already-elapsed timestamps), so the
 * UI can fall back to generic copy without exposing a bogus cooldown.
 */
export function computeRetryAfterSec(
  retryAfterIso: string | undefined,
  now: number = Date.now()
): number | undefined {
  if (!retryAfterIso) return undefined;
  const target = Date.parse(retryAfterIso);
  if (!Number.isFinite(target)) return undefined;
  const diffSec = Math.ceil((target - now) / 1000);
  return diffSec > 0 ? diffSec : undefined;
}

/**
 * Maps a durable job's in-flight state to the UI's active RefreshState,
 * defaulting unknown/null polls to "queued" rather than "idle" so a lost
 * poll response never implies the work stopped.
 */
export function deriveActiveRefreshState(
  jobState: string | undefined
): "queued" | "running" {
  return jobState === "running" ? "running" : "queued";
}

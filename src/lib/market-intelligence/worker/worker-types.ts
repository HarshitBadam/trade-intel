import type { PreparedTickerAnalysis } from "@/lib/market-data/news/analysis";
import type {
  markRefreshStaging,
  publishAnalysisDoc,
  readAnalysisDoc,
  recordAnalysisError,
  touchNewsLoadedAt,
  upsertArticles,
} from "@/lib/market-data/news/store";
import type { StoredArticle } from "@/lib/market-data/types";
import type {
  acquireTickerLock,
  isActiveTickerOwner,
  releaseTickerLock,
  renewTickerLock,
} from "../job-store/job-locks";
import type { getRefreshJob } from "../job-store/job-reservations";
import type { selectCandidateSet } from "../repository";

export type RefreshWorkerResult =
  | {
      ok: true;
      generation: number;
      outcome: "published" | "reused" | "no_news";
      concludedAt: string;
      newsCheckedAt: string;
    }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      retryAfter?: string;
    };

export type RefreshWorkerDependencies = {
  acquireLock: typeof acquireTickerLock;
  renewLock: typeof renewTickerLock;
  releaseLock: typeof releaseTickerLock;
  readAnalysis: typeof readAnalysisDoc;
  loadNews: (ticker: string) => Promise<StoredArticle[]>;
  markStaging: typeof markRefreshStaging;
  upsert: typeof upsertArticles;
  touchLoadedAt: typeof touchNewsLoadedAt;
  selectCandidates: typeof selectCandidateSet;
  prepareAnalysis: (
    ticker: string,
    articles: readonly StoredArticle[]
  ) => Promise<PreparedTickerAnalysis>;
  publishAnalysis: typeof publishAnalysisDoc;
  revalidateTicker: (ticker: string) => void;
  groqConfigured: boolean;
  now: () => number;
};

export type FinalizeDependencies = {
  getJob: typeof getRefreshJob;
  readAnalysis: typeof readAnalysisDoc;
  recordError: typeof recordAnalysisError;
  selectCandidates: typeof selectCandidateSet;
  publishAnalysis: typeof publishAnalysisDoc;
  acquireLock: typeof acquireTickerLock;
  releaseLock: typeof releaseTickerLock;
  isActiveOwner: typeof isActiveTickerOwner;
  revalidateTicker: (ticker: string) => void;
};

export type FinalizeTerminalFailureResult = { claimed: boolean };

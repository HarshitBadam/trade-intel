import "server-only";

import { revalidateTag } from "next/cache";
import { hasAlpaca, hasGroq, hasPolygon } from "@/lib/config";
import {
  markRefreshStaging,
  publishAnalysisDoc,
  readAnalysisDoc,
  recordAnalysisError,
  touchNewsLoadedAt,
  upsertArticles,
} from "@/lib/market-data/news-store";
import {
  fetchAlpacaNews,
  fetchPolygonNewsWithInsights,
} from "@/lib/market-data/news-loaders";
import { prepareTickerAnalysis } from "@/lib/market-data/analysis";
import type {
  AnalysisDoc,
  StoredArticle,
} from "@/lib/market-data/types";
import type { PreparedTickerAnalysis } from "@/lib/market-data/analysis";
import {
  acquireTickerLock,
  claimTerminalFinalization,
  extendActiveReservation,
  getRefreshJob,
  isActiveTickerOwner,
  REFRESH_ACTIVE_TTL_SEC,
  releaseTickerLock,
  renewTickerLock,
} from "./job-store";
import type { TickerRefreshPayload } from "./queue";
import {
  MARKET_PIPELINE_VERSION,
  SOURCE_WINDOW_DAYS,
  selectCandidateSet,
} from "./repository";

const LOCK_HEARTBEAT_MS = 30_000;

export type RefreshWorkerResult =
  | { ok: true; generation: number; outcome: "published" | "reused" | "no_news" }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      retryAfter?: string;
    };

/**
 * Duck-types a typed provider/model retry hint (e.g. `LlmRequestError` from
 * `@/lib/llm`, or any thrown error carrying `retryAfterMs`/`retryAfter`) so
 * the worker can preserve honest retry timing instead of always defaulting
 * to a fixed cooldown.
 */
function extractRetryAfterMs(error: unknown, nowMs: number): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const withRetry = error as { retryAfterMs?: unknown; retryAfter?: unknown };
  if (
    typeof withRetry.retryAfterMs === "number" &&
    Number.isFinite(withRetry.retryAfterMs)
  ) {
    return Math.max(0, withRetry.retryAfterMs);
  }
  if (typeof withRetry.retryAfter === "string") {
    const parsed = Date.parse(withRetry.retryAfter);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - nowMs);
  }
  if (
    typeof withRetry.retryAfter === "number" &&
    Number.isFinite(withRetry.retryAfter)
  ) {
    return Math.max(0, withRetry.retryAfter);
  }
  return undefined;
}

async function loadNewsFromProviders(ticker: string): Promise<StoredArticle[]> {
  if (hasPolygon) {
    try {
      return await fetchPolygonNewsWithInsights(ticker);
    } catch (error) {
      if (!hasAlpaca) throw error;
      console.warn(`[market-intelligence] Polygon failed for ${ticker}; using Alpaca`);
    }
  }
  if (hasAlpaca) return fetchAlpacaNews(ticker);
  throw new Error("news providers are unavailable");
}

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

const defaultWorkerDependencies: RefreshWorkerDependencies = {
  acquireLock: acquireTickerLock,
  renewLock: renewTickerLock,
  releaseLock: releaseTickerLock,
  readAnalysis: readAnalysisDoc,
  loadNews: loadNewsFromProviders,
  markStaging: markRefreshStaging,
  upsert: upsertArticles,
  touchLoadedAt: touchNewsLoadedAt,
  selectCandidates: selectCandidateSet,
  prepareAnalysis: prepareTickerAnalysis,
  publishAnalysis: publishAnalysisDoc,
  revalidateTicker: (ticker) => revalidateTag(`news:${ticker}`),
  groqConfigured: hasGroq,
  now: () => Date.now(),
};

function nextGeneration(doc: AnalysisDoc | null): {
  expected: number | null;
  next: number;
} {
  return {
    expected: typeof doc?.generation === "number" ? doc.generation : null,
    next: (doc?.generation ?? 0) + 1,
  };
}

function usablePublishedBundle(doc: AnalysisDoc | null): boolean {
  if (!doc?.published_article_ids || doc.analysis_status !== "complete") {
    return false;
  }
  const checked = Date.parse(doc.news_checked_at ?? "");
  return Number.isFinite(checked) && Date.now() - checked < 48 * 60 * 60 * 1000;
}

async function publishNoNews(
  ticker: string,
  current: AnalysisDoc | null,
  checkedAt: string,
  dependencies: RefreshWorkerDependencies
): Promise<number> {
  const generation = nextGeneration(current);
  const published = await dependencies.publishAnalysis(
    {
      ticker,
      pipeline_version: MARKET_PIPELINE_VERSION,
      generation: generation.next,
      analysis_status: "no_news",
      published_article_ids: [],
      published_article_labels: [],
      article_count: 0,
      news_checked_at: checkedAt,
      last_success_at: checkedAt,
      last_error_code: "",
      source_window_days: SOURCE_WINDOW_DAYS,
    },
    generation.expected
  );
  if (!published) throw new Error("obsolete_generation");
  return generation.next;
}

export async function runTickerRefreshJob(
  payload: TickerRefreshPayload,
  overrides: Partial<RefreshWorkerDependencies> = {}
): Promise<RefreshWorkerResult> {
  const dependencies = { ...defaultWorkerDependencies, ...overrides };
  const { ticker, workId } = payload;
  const acquired = await dependencies.acquireLock(ticker, workId);
  if (!acquired) {
    return { ok: false, retryable: true, errorCode: "ticker_locked" };
  }

  let ownsLock = true;
  const heartbeat = setInterval(() => {
    void dependencies.renewLock(ticker, workId)
      .then((renewed) => {
        if (!renewed) ownsLock = false;
      })
      .catch(() => {
        ownsLock = false;
      });
    // Keep the active-ticker reservation alive while the worker is
    // demonstrably still running; owner-conditional, so it never revives a
    // reservation that a newer job has already taken over.
    void extendActiveReservation(ticker, workId, REFRESH_ACTIVE_TTL_SEC).catch(
      () => false
    );
  }, LOCK_HEARTBEAT_MS);

  // Revalidates lock ownership immediately before a manifest CAS write.
  // Returning false here means publication must be skipped entirely: an
  // expired/lost lock means another owner may already be acting on this
  // ticker, so writing anyway could race a concurrent worker.
  const reaffirmLock = async (): Promise<boolean> => {
    try {
      const renewed = await dependencies.renewLock(ticker, workId);
      ownsLock = renewed;
      return renewed;
    } catch {
      ownsLock = false;
      return false;
    }
  };

  try {
    const current = await dependencies.readAnalysis(ticker);
    const checkedMs = Date.parse(current?.news_checked_at ?? "");
    const newsIsFresh =
      Number.isFinite(checkedMs) &&
      dependencies.now() - checkedMs <= 60 * 60 * 1000;

    if (!newsIsFresh) {
      const articles = await dependencies.loadNews(ticker);
      if (!ownsLock) {
        return { ok: false, retryable: true, errorCode: "lock_lost" };
      }
      // Written before the rows land in storage: any reader without its own
      // manifest/watermark now knows a refresh is in flight and must not
      // treat freshly-upserted rows as safe legacy data. Left in place on
      // any failure below, so a dead refresh fails closed instead of
      // silently reverting to the old unscoped behavior.
      await dependencies.markStaging(ticker);
      await dependencies.upsert(ticker, articles);
      await dependencies.touchLoadedAt(ticker);
    }

    const checkedAt = new Date(dependencies.now()).toISOString();
    const candidate = await dependencies.selectCandidates(ticker);
    if (candidate.articles.length === 0) {
      if (!(await reaffirmLock())) {
        return { ok: false, retryable: true, errorCode: "lock_lost" };
      }
      const generation = await publishNoNews(
        ticker,
        current,
        checkedAt,
        dependencies
      );
      dependencies.revalidateTicker(ticker);
      return { ok: true, generation, outcome: "no_news" };
    }

    const generation = nextGeneration(current);
    if (
      current?.analysis_status === "complete" &&
      current.analysis_fingerprint === candidate.analysisFingerprint
    ) {
      if (!(await reaffirmLock())) {
        return { ok: false, retryable: true, errorCode: "lock_lost" };
      }
      const published = await dependencies.publishAnalysis(
        {
          ...current,
          ticker,
          pipeline_version: MARKET_PIPELINE_VERSION,
          generation: generation.next,
          published_article_ids: candidate.articleIds,
          content_fingerprint: candidate.contentFingerprint,
          analysis_fingerprint: candidate.analysisFingerprint,
          news_checked_at: checkedAt,
          last_success_at: checkedAt,
          last_error_code: "",
        },
        generation.expected
      );
      if (!published) throw new Error("obsolete_generation");
      dependencies.revalidateTicker(ticker);
      return { ok: true, generation: generation.next, outcome: "reused" };
    }

    if (!dependencies.groqConfigured) {
      return { ok: false, retryable: false, errorCode: "groq_unconfigured" };
    }
    if (!ownsLock) {
      return { ok: false, retryable: true, errorCode: "lock_lost" };
    }
    const prepared = await dependencies.prepareAnalysis(
      ticker,
      candidate.articles
    );
    if (!(await reaffirmLock())) {
      return { ok: false, retryable: true, errorCode: "lock_lost" };
    }
    const analyzedAt = new Date(dependencies.now()).toISOString();
    const published = await dependencies.publishAnalysis(
      {
        ticker,
        ...prepared.verdict,
        pipeline_version: MARKET_PIPELINE_VERSION,
        generation: generation.next,
        analysis_status: "complete",
        published_article_ids: candidate.articleIds,
        published_article_labels: prepared.labels.map((label) => ({
          article_id: label._id,
          sentiment: label.sentiment,
          importance: label.importance,
          key_observations: label.key_observations,
        })),
        content_fingerprint: candidate.contentFingerprint,
        analysis_fingerprint: candidate.analysisFingerprint,
        news_checked_at: checkedAt,
        analyzed_at: analyzedAt,
        last_success_at: analyzedAt,
        last_error_code: "",
      },
      generation.expected
    );
    if (!published) throw new Error("obsolete_generation");
    dependencies.revalidateTicker(ticker);
    return { ok: true, generation: generation.next, outcome: "published" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "refresh_failed";
    const nonRetryable =
      message === "obsolete_generation" || message.includes("Invalid ticker");
    const retryAfterMs = nonRetryable
      ? undefined
      : extractRetryAfterMs(error, dependencies.now());
    return {
      ok: false,
      retryable: !nonRetryable,
      errorCode: nonRetryable ? message : "refresh_transient_failure",
      ...(retryAfterMs !== undefined
        ? {
            retryAfter: new Date(
              dependencies.now() + retryAfterMs
            ).toISOString(),
          }
        : {}),
    };
  } finally {
    clearInterval(heartbeat);
    await dependencies.releaseLock(ticker, workId).catch(() => false);
  }
}

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

const defaultFinalizeDependencies: FinalizeDependencies = {
  getJob: getRefreshJob,
  readAnalysis: readAnalysisDoc,
  recordError: recordAnalysisError,
  selectCandidates: selectCandidateSet,
  publishAnalysis: publishAnalysisDoc,
  acquireLock: acquireTickerLock,
  releaseLock: releaseTickerLock,
  isActiveOwner: isActiveTickerOwner,
  revalidateTicker: (ticker) => revalidateTag(`news:${ticker}`),
};

/**
 * Called only after QStash exhausts delivery attempts (or a direct
 * nonretryable worker response). A current bundle is retained. For a
 * cold/hard-expired ticker, provider-fetched rows can be published as an
 * explicit news-only bundle without attaching an old verdict.
 *
 * The one branch that performs a CAS write (the news-only fallback) takes a
 * fresh ticker lock and rechecks active ownership immediately beforehand:
 * by the time QStash/failure-callback finalization runs, the original
 * worker lock has normally already been released, and this guards against
 * racing a fresh worker that has since taken over the ticker.
 */
export async function finalizeFailedRefresh(
  payload: TickerRefreshPayload,
  overrides: Partial<FinalizeDependencies> = {}
): Promise<void> {
  const dependencies = { ...defaultFinalizeDependencies, ...overrides };
  const [job, current] = await Promise.all([
    dependencies.getJob(payload.workId),
    dependencies.readAnalysis(payload.ticker),
  ]);
  if (usablePublishedBundle(current)) {
    await dependencies.recordError(payload.ticker, "refresh_failed");
    dependencies.revalidateTicker(payload.ticker);
    return;
  }
  const loadedAt = Date.parse(current?.news_loaded_at ?? "");
  const requestedAt = Date.parse(job?.requestedAt ?? "");
  if (!Number.isFinite(loadedAt) || !Number.isFinite(requestedAt) || loadedAt < requestedAt) {
    await dependencies.recordError(payload.ticker, "refresh_failed");
    dependencies.revalidateTicker(payload.ticker);
    return;
  }
  const candidate = await dependencies.selectCandidates(payload.ticker);
  if (candidate.articles.length === 0) {
    await dependencies.recordError(payload.ticker, "refresh_failed");
    dependencies.revalidateTicker(payload.ticker);
    return;
  }

  const lockOwner = `finalize:${payload.workId}`;
  const lockAcquired = await dependencies
    .acquireLock(payload.ticker, lockOwner)
    .catch(() => false);
  if (!lockAcquired) {
    // Something else (most likely a fresh worker run) currently owns the
    // ticker; publishing the news-only fallback here could race it, so we
    // only preserve honest error state and let the newer owner win.
    await dependencies.recordError(payload.ticker, "refresh_failed");
    dependencies.revalidateTicker(payload.ticker);
    return;
  }
  try {
    const stillOwnsActive = await dependencies
      .isActiveOwner(payload.ticker, payload.workId)
      .catch(() => false);
    if (!stillOwnsActive) {
      await dependencies.recordError(payload.ticker, "refresh_failed");
      return;
    }
    const generation = nextGeneration(current);
    const published = await dependencies.publishAnalysis(
      {
        ticker: payload.ticker,
        pipeline_version: MARKET_PIPELINE_VERSION,
        generation: generation.next,
        analysis_status: "unavailable",
        published_article_ids: candidate.articleIds,
        published_article_labels: [],
        content_fingerprint: candidate.contentFingerprint,
        analysis_fingerprint: candidate.analysisFingerprint,
        article_count: candidate.articleIds.length,
        source_window_days: SOURCE_WINDOW_DAYS,
        news_checked_at: current?.news_loaded_at,
        last_success_at: current?.news_loaded_at,
        last_error_code: "analysis_unavailable",
      },
      generation.expected
    );
    if (!published) {
      await dependencies.recordError(payload.ticker, "refresh_failed");
      return;
    }
    dependencies.revalidateTicker(payload.ticker);
  } finally {
    await dependencies.releaseLock(payload.ticker, lockOwner).catch(() => false);
  }
}

export type FinalizeTerminalFailureResult = { claimed: boolean };

/**
 * Coordinates terminal-failure finalization between the two call sites that
 * can both observe a nonretryable outcome for the same job: a direct worker
 * response and QStash's failure callback after retries are exhausted. Only
 * one of them wins the atomic claim (fenced on the job being nonterminal and
 * `active:<ticker>` still pointing at this workId); the loser must no-op
 * rather than re-run fallback publication or mark an already-terminal job.
 */
export async function finalizeTerminalFailure(
  payload: TickerRefreshPayload,
  errorCode: string,
  retryAfter: string,
  overrides: Partial<FinalizeDependencies> = {}
): Promise<FinalizeTerminalFailureResult> {
  const claimed = await claimTerminalFinalization(
    payload.workId,
    payload.ticker,
    errorCode,
    retryAfter
  );
  if (!claimed) {
    return { claimed: false };
  }
  await finalizeFailedRefresh(payload, overrides);
  return { claimed: true };
}

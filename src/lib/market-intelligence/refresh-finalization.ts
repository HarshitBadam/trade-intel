import "server-only";

import { revalidateTag } from "next/cache";
import {
  publishAnalysisDoc,
  readAnalysisDoc,
  recordAnalysisError,
} from "@/lib/market-data/news-store";
import type { AnalysisDoc } from "@/lib/market-data/types";
import {
  acquireTickerLock,
  isActiveTickerOwner,
  releaseTickerLock,
} from "./job-locks";
import {
  claimTerminalFinalization,
  getRefreshJob,
} from "./job-reservations";
import type { TickerRefreshPayload } from "./queue";
import {
  MARKET_PIPELINE_VERSION,
  SOURCE_WINDOW_DAYS,
  selectCandidateSet,
} from "./repository";
import type {
  FinalizeDependencies,
  FinalizeTerminalFailureResult,
} from "./worker-types";

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

async function recordFailure(
  ticker: string,
  dependencies: FinalizeDependencies
): Promise<void> {
  await dependencies.recordError(ticker, "refresh_failed");
  dependencies.revalidateTicker(ticker);
}

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
    await recordFailure(payload.ticker, dependencies);
    return;
  }
  const loadedAt = Date.parse(current?.news_loaded_at ?? "");
  const requestedAt = Date.parse(job?.requestedAt ?? "");
  if (
    !Number.isFinite(loadedAt) ||
    !Number.isFinite(requestedAt) ||
    loadedAt < requestedAt
  ) {
    await recordFailure(payload.ticker, dependencies);
    return;
  }
  const candidate = await dependencies.selectCandidates(payload.ticker);
  if (candidate.articles.length === 0) {
    await recordFailure(payload.ticker, dependencies);
    return;
  }

  // Failure callbacks normally run after the worker lease is gone. A fresh
  // lock plus active-owner check fences this fallback CAS from a newer worker.
  const lockOwner = `finalize:${payload.workId}`;
  const lockAcquired = await dependencies
    .acquireLock(payload.ticker, lockOwner)
    .catch(() => false);
  if (!lockAcquired) {
    await recordFailure(payload.ticker, dependencies);
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

// Direct worker responses and QStash failure callbacks can observe the same
// terminal result. The fenced transition grants exactly one finalizer.
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
  if (!claimed) return { claimed: false };
  await finalizeFailedRefresh(payload, overrides);
  return { claimed: true };
}

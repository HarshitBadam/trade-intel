import "server-only";

import { revalidateTag } from "next/cache";
import { hasAlpaca, hasGroq, hasPolygon } from "@/lib/config";
import { prepareTickerAnalysis } from "@/lib/market-data/news/analysis";
import {
  markRefreshStaging,
  publishAnalysisDoc,
  readAnalysisDoc,
  touchNewsLoadedAt,
  upsertArticles,
} from "@/lib/market-data/news/store";
import {
  fetchAlpacaNews,
  fetchPolygonNewsWithInsights,
} from "@/lib/market-data/news/loaders";
import type { AnalysisDoc, StoredArticle } from "@/lib/market-data/types";
import {
  acquireTickerLock,
  extendActiveReservation,
  releaseTickerLock,
  renewTickerLock,
} from "../job-store/job-locks";
import { REFRESH_ACTIVE_TTL_SEC } from "../job-store/job-store-types";
import type { TickerRefreshPayload } from "../queue";
import {
  MARKET_PIPELINE_VERSION,
  SOURCE_WINDOW_DAYS,
  selectCandidateSet,
} from "../repository";
import type {
  RefreshWorkerDependencies,
  RefreshWorkerResult,
} from "./worker-types";

const LOCK_HEARTBEAT_MS = 30_000;

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

async function publishNoNews(
  ticker: string,
  current: AnalysisDoc | null,
  checkedAt: string,
  concludedAt: string,
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
      concluded_at: concludedAt,
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
    // Reservation renewal is owner-conditional, so this cannot revive a job
    // after a newer reservation has taken over.
    void extendActiveReservation(ticker, workId, REFRESH_ACTIVE_TTL_SEC).catch(
      () => false
    );
  }, LOCK_HEARTBEAT_MS);

  // Every manifest CAS is preceded by a fresh lease check. A lost lease means
  // another worker may already own publication, so this worker must not write.
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
    const articles = await dependencies.loadNews(ticker);
    if (!ownsLock) {
      return { ok: false, retryable: true, errorCode: "lock_lost" };
    }
    // Accepted refreshes always perform a provider check before advancing the
    // conclusion clock; trigger deduplication happens before this point.
    await dependencies.markStaging(ticker);
    await dependencies.upsert(ticker, articles);
    await dependencies.touchLoadedAt(ticker);
    const checkedAt = new Date(dependencies.now()).toISOString();
    const candidate = await dependencies.selectCandidates(ticker);

    if (candidate.articles.length === 0) {
      if (!(await reaffirmLock())) {
        return { ok: false, retryable: true, errorCode: "lock_lost" };
      }
      const concludedAt = new Date(dependencies.now()).toISOString();
      const generation = await publishNoNews(
        ticker,
        current,
        checkedAt,
        concludedAt,
        dependencies
      );
      dependencies.revalidateTicker(ticker);
      return {
        ok: true,
        generation,
        outcome: "no_news",
        concludedAt,
        newsCheckedAt: checkedAt,
      };
    }

    const generation = nextGeneration(current);
    if (
      current?.analysis_status === "complete" &&
      current.analysis_fingerprint === candidate.analysisFingerprint
    ) {
      if (!(await reaffirmLock())) {
        return { ok: false, retryable: true, errorCode: "lock_lost" };
      }
      const concludedAt = new Date(dependencies.now()).toISOString();
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
          concluded_at: concludedAt,
          last_success_at: checkedAt,
          last_error_code: "",
        },
        generation.expected
      );
      if (!published) throw new Error("obsolete_generation");
      dependencies.revalidateTicker(ticker);
      return {
        ok: true,
        generation: generation.next,
        outcome: "reused",
        concludedAt,
        newsCheckedAt: checkedAt,
      };
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
        concluded_at: analyzedAt,
        analyzed_at: analyzedAt,
        last_success_at: analyzedAt,
        last_error_code: "",
      },
      generation.expected
    );
    if (!published) throw new Error("obsolete_generation");
    dependencies.revalidateTicker(ticker);
    return {
      ok: true,
      generation: generation.next,
      outcome: "published",
      concludedAt: analyzedAt,
      newsCheckedAt: checkedAt,
    };
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

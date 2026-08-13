import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { StoredArticle } from "../../src/lib/market-data/types";
import {
  runTickerRefreshJob,
  type RefreshWorkerDependencies,
} from "../../src/lib/market-intelligence/worker";

const NOW = Date.parse("2026-08-05T05:00:00.000Z");
const WORK_ID = "11111111-1111-4111-8111-111111111111";

const article: StoredArticle = {
  _id: "art_one",
  page_content: "A material company update.",
  metadata: {
    title: "Material update",
    source: "Test Wire",
    publication_date: "2026-08-05T04:00:00.000Z",
    sentiment: "Neutral",
    importance: "Medium",
    key_observations: "",
    url: "https://example.com/material-update",
    ticker: "AAPL",
    description: "A material company update.",
    event: "Company Update",
    ingested_at: "2026-08-05T04:01:00.000Z",
    label_source: "polygon",
  },
};

function dependencies(
  events: string[],
  overrides: Partial<RefreshWorkerDependencies> = {}
): RefreshWorkerDependencies {
  return {
    acquireLock: async () => {
      events.push("lock:acquire");
      return true;
    },
    renewLock: async () => true,
    releaseLock: async () => {
      events.push("lock:release");
      return true;
    },
    readAnalysis: async () => {
      events.push("analysis:read");
      return null;
    },
    loadNews: async () => {
      events.push("news:load");
      return [article];
    },
    markStaging: async () => {
      events.push("staging:mark");
    },
    upsert: async () => {
      events.push("articles:upsert");
      return { upserted: 1, inserted: 1, skippedAi: 0 };
    },
    touchLoadedAt: async () => {
      events.push("news:touch");
    },
    selectCandidates: async () => {
      events.push("candidates:select");
      return {
        articles: [article],
        articleIds: [article._id],
        contentFingerprint: "content-v1",
        analysisFingerprint: "analysis-v1",
      };
    },
    prepareAnalysis: async () => {
      events.push("analysis:prepare");
      return {
        labels: [
          {
            _id: article._id,
            sentiment: "Positive",
            importance: "High",
            key_observations: "Material update",
          },
        ],
        verdict: {
          overall_sentiment: "Positive",
          sentiment_score: 0.7,
          confidence: "High",
          summary: "The update is constructive.",
          key_drivers: [],
          risks: [],
          model: "test-model",
          article_count: 1,
          source_window_days: 90,
        },
      };
    },
    publishAnalysis: async () => {
      events.push("manifest:publish");
      return true;
    },
    revalidateTicker: () => {
      events.push("cache:revalidate");
    },
    groqConfigured: true,
    now: () => NOW,
    ...overrides,
  };
}

test("transient analysis failures always release the ticker lease", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    prepareAnalysis: async () => {
      events.push("analysis:prepare");
      throw new Error("provider timeout");
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: false,
    retryable: true,
    errorCode: "refresh_transient_failure",
  });
  assert.equal(events.at(-1), "lock:release");
});

test("losing the lock immediately before the no_news publish aborts without publishing", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    loadNews: async () => [],
    upsert: async () => ({ upserted: 0, inserted: 0, skippedAi: 0 }),
    selectCandidates: async () => ({
      articles: [],
      articleIds: [],
      contentFingerprint: "empty-content",
      analysisFingerprint: "empty-analysis",
    }),
    renewLock: async () => {
      events.push("lock:renew");
      return false;
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: false,
    retryable: true,
    errorCode: "lock_lost",
  });
  assert.equal(events.includes("manifest:publish"), false);
  assert.equal(events.at(-1), "lock:release");
});

test("losing the lock immediately before the reused-fingerprint publish aborts without publishing", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    readAnalysis: async () => ({
      ticker: "AAPL",
      generation: 4,
      analysis_status: "complete",
      analysis_fingerprint: "analysis-v1",
      news_checked_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    }),
    prepareAnalysis: async () => {
      throw new Error("Groq must not run");
    },
    renewLock: async () => {
      events.push("lock:renew");
      return false;
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: false,
    retryable: true,
    errorCode: "lock_lost",
  });
  assert.equal(events.includes("manifest:publish"), false);
  assert.equal(events.at(-1), "lock:release");
});

test("losing the lock immediately before the analyzed publish aborts without publishing", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    renewLock: async () => {
      events.push("lock:renew");
      return false;
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: false,
    retryable: true,
    errorCode: "lock_lost",
  });
  assert.equal(events.includes("manifest:publish"), false);
  assert.equal(events.at(-1), "lock:release");
});

test("typed provider retry timing propagates through the worker result", async () => {
  const events: string[] = [];
  const retryAfterMs = 42_000;
  class FakeLlmRequestError extends Error {
    retryAfterMs = retryAfterMs;
  }
  const deps = dependencies(events, {
    prepareAnalysis: async () => {
      throw new FakeLlmRequestError("rate limited");
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.retryable, true);
  assert.equal(result.errorCode, "refresh_transient_failure");
  assert.equal(result.retryAfter, new Date(NOW + retryAfterMs).toISOString());
});

test("obsolete generation publication is non-retryable and releases the lease", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    publishAnalysis: async () => {
      events.push("manifest:publish");
      return false;
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: false,
    retryable: false,
    errorCode: "obsolete_generation",
  });
  assert.equal(events.at(-1), "lock:release");
});

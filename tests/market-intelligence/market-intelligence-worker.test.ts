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

test("worker performs provider, analysis, and manifest publication sequentially", async () => {
  const events: string[] = [];
  let publishedLabels:
    | {
        article_id: string;
        sentiment: string;
        importance: string;
        key_observations: string;
      }[]
    | undefined;
  let publishedConclusion: string | undefined;
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    dependencies(events, {
      publishAnalysis: async (doc) => {
        events.push("manifest:publish");
        publishedLabels = doc.published_article_labels;
        publishedConclusion = doc.concluded_at;
        return true;
      },
    })
  );

  assert.deepEqual(result, {
    ok: true,
    generation: 1,
    outcome: "published",
    concludedAt: new Date(NOW).toISOString(),
    newsCheckedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(events, [
    "lock:acquire",
    "analysis:read",
    "news:load",
    "staging:mark",
    "articles:upsert",
    "news:touch",
    "candidates:select",
    "analysis:prepare",
    "manifest:publish",
    "cache:revalidate",
    "lock:release",
  ]);
  assert.deepEqual(publishedLabels, [
    {
      article_id: article._id,
      sentiment: "Positive",
      importance: "High",
      key_observations: "Material update",
    },
  ]);
  assert.equal(publishedConclusion, new Date(NOW).toISOString());
});

test("unchanged analysis fingerprints skip Groq and refresh the manifest", async () => {
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
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: true,
    generation: 5,
    outcome: "reused",
    concludedAt: new Date(NOW).toISOString(),
    newsCheckedAt: new Date(NOW).toISOString(),
  });
  assert.equal(events.includes("analysis:prepare"), false);
  assert.equal(events.at(-1), "lock:release");
});

test("a refresh always checks the provider before reconfirming a manifest", async () => {
  const events: string[] = [];
  const providerCheckedAt = new Date(
    NOW - 30 * 60 * 1000
  ).toISOString();
  const analyzedAt = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
  let publishedCheckedAt: string | undefined;
  let publishedConclusion: string | undefined;
  let publishedAnalyzedAt: string | undefined;
  const deps = dependencies(events, {
    readAnalysis: async () => ({
      ticker: "AAPL",
      generation: 4,
      analysis_status: "complete",
      analysis_fingerprint: "analysis-v1",
      news_checked_at: providerCheckedAt,
      analyzed_at: analyzedAt,
    }),
    prepareAnalysis: async () => {
      throw new Error("An unchanged fingerprint must not call Groq");
    },
    publishAnalysis: async (doc) => {
      events.push("manifest:publish");
      publishedCheckedAt = doc.news_checked_at;
      publishedConclusion = doc.concluded_at;
      publishedAnalyzedAt = doc.analyzed_at;
      return true;
    },
  });

  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: true,
    generation: 5,
    outcome: "reused",
    concludedAt: new Date(NOW).toISOString(),
    newsCheckedAt: new Date(NOW).toISOString(),
  });
  assert.equal(publishedCheckedAt, new Date(NOW).toISOString());
  assert.equal(publishedConclusion, new Date(NOW).toISOString());
  assert.equal(publishedAnalyzedAt, analyzedAt);
  assert.equal(events.includes("news:load"), true);
});

test("zero stored articles publish a terminal no-news generation", async () => {
  const events: string[] = [];
  let publishedConclusion: string | undefined;
  const deps = dependencies(events, {
    loadNews: async () => [],
    upsert: async () => ({ upserted: 0, inserted: 0, skippedAi: 0 }),
    selectCandidates: async () => ({
      articles: [],
      articleIds: [],
      contentFingerprint: "empty-content",
      analysisFingerprint: "empty-analysis",
    }),
    publishAnalysis: async (doc) => {
      events.push("manifest:publish");
      publishedConclusion = doc.concluded_at;
      return true;
    },
  });
  const result = await runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    deps
  );

  assert.deepEqual(result, {
    ok: true,
    generation: 1,
    outcome: "no_news",
    concludedAt: new Date(NOW).toISOString(),
    newsCheckedAt: new Date(NOW).toISOString(),
  });
  assert.equal(events.includes("analysis:prepare"), false);
  assert.equal(publishedConclusion, new Date(NOW).toISOString());
  assert.equal(events.at(-1), "lock:release");
});

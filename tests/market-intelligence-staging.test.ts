import "./no-live-keys";
import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { AnalysisDoc, StoredArticle } from "../src/lib/market-data/types";
import { buildManifestPublishUpdate } from "../src/lib/market-data/news-store";
import {
  filterCommittedArticles,
  legacyFallbackAllowed,
} from "../src/lib/market-intelligence/repository";
import type { RefreshWorkerDependencies } from "../src/lib/market-intelligence/worker";

let store: typeof import("../src/lib/market-intelligence/job-store");
let worker: typeof import("../src/lib/market-intelligence/worker");

before(async () => {
  store = await import("../src/lib/market-intelligence/job-store");
  worker = await import("../src/lib/market-intelligence/worker");
});

function article(
  id: string,
  overrides: Partial<StoredArticle["metadata"]> = {}
): StoredArticle {
  return {
    _id: id,
    page_content: `content for ${id}`,
    metadata: {
      title: `Title ${id}`,
      source: "Test Wire",
      publication_date: "2026-08-01T00:00:00.000Z",
      importance: "Medium",
      sentiment: "Neutral",
      key_observations: "",
      url: `https://example.com/${id}`,
      ticker: "AAPL",
      description: `Description ${id}`,
      event: "Update",
      ingested_at: "2026-08-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

// --- buildManifestPublishUpdate (news-store): every real publish clears the marker ---

test("buildManifestPublishUpdate always unsets refresh_staging_at, even if the doc carries one", () => {
  const doc: AnalysisDoc = {
    ticker: "AAPL",
    generation: 2,
    refresh_staging_at: "2026-08-05T04:59:00.000Z",
    published_article_ids: ["art_one"],
  };

  const { fields, unset } = buildManifestPublishUpdate(doc);

  assert.deepEqual(unset, { refresh_staging_at: "" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(fields, "refresh_staging_at"),
    false,
    "the stale marker value must never leak back into $set"
  );
  assert.deepEqual(fields.published_article_ids, ["art_one"]);
});

test("buildManifestPublishUpdate preserves every other field verbatim", () => {
  const doc: AnalysisDoc = {
    ticker: "AAPL",
    generation: 3,
    analysis_status: "complete",
    published_article_ids: ["art_one", "art_two"],
  };

  const { fields } = buildManifestPublishUpdate(doc);

  assert.equal(fields.ticker, "AAPL");
  assert.equal(fields.generation, 3);
  assert.equal(fields.analysis_status, "complete");
  assert.deepEqual(fields.published_article_ids, ["art_one", "art_two"]);
});

test("buildManifestPublishUpdate always unsets the marker even when the doc never had one", () => {
  const doc: AnalysisDoc = { ticker: "AAPL", generation: 1 };
  const { unset } = buildManifestPublishUpdate(doc);
  assert.deepEqual(unset, { refresh_staging_at: "" });
});

// --- legacyFallbackAllowed (repository): the shared homepage/details gate ---

test("legacyFallbackAllowed: true for genuinely never-staged legacy tickers", () => {
  assert.equal(legacyFallbackAllowed(null), true);
  assert.equal(legacyFallbackAllowed({ ticker: "AAPL", generation: 0 }), true);
});

test("legacyFallbackAllowed: false while a refresh is staging unpublished rows", () => {
  assert.equal(
    legacyFallbackAllowed({
      ticker: "AAPL",
      generation: 0,
      refresh_staging_at: "2026-08-05T05:00:00.000Z",
    }),
    false
  );
});

// --- filterCommittedArticles (StockSage evidence): staging-aware no-watermark branch ---

test("StockSage: first cold refresh staging hides this run's unpublished rows but keeps older legacy history", () => {
  const stagingAt = "2026-08-05T05:00:00.000Z";
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 0,
    refresh_staging_at: stagingAt,
  };
  const preexistingLegacy = article("art_legacy", {
    ingested_at: "2026-07-01T00:00:00.000Z", // predates the marker
  });
  const stagedByThisRun = article("art_staged", {
    ingested_at: "2026-08-05T05:00:30.000Z", // at/after the marker
  });

  const result = filterCommittedArticles(
    [preexistingLegacy, stagedByThisRun],
    analysis
  );

  assert.deepEqual(result.map((row) => row._id), ["art_legacy"]);
});

test("StockSage: genuinely never-staged legacy ticker keeps full unscoped history", () => {
  const analysis: AnalysisDoc = { ticker: "AAPL", generation: 0 };
  const rows = [article("art_a"), article("art_b")];

  const result = filterCommittedArticles(rows, analysis);

  assert.deepEqual(result.map((row) => row._id), ["art_a", "art_b"]);
});

test("StockSage: a failed first refresh (marker left set, never published) still fails closed on new rows", () => {
  // Simulates: worker wrote the marker, upserted rows, then crashed before
  // ever reaching a successful publishAnalysis call. No watermark exists,
  // and the marker is still active.
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 0,
    refresh_staging_at: "2026-08-05T05:00:00.000Z",
  };
  const rows = [
    article("art_from_dead_run", { ingested_at: "2026-08-05T05:00:05.000Z" }),
  ];

  const result = filterCommittedArticles(rows, analysis);

  assert.deepEqual(result, []);
});

// --- worker: marker written before upsert, and cleared on every success branch ---

const NOW = Date.parse("2026-08-05T05:00:00.000Z");
const WORK_ID = "22222222-2222-4222-8222-222222222222";

const candidateArticle: StoredArticle = article("art_one", {
  ingested_at: "2026-08-05T04:01:00.000Z",
});

function workerDeps(
  events: string[],
  overrides: Partial<RefreshWorkerDependencies> = {}
): RefreshWorkerDependencies {
  return {
    acquireLock: async () => true,
    renewLock: async () => true,
    releaseLock: async () => true,
    readAnalysis: async () => {
      events.push("analysis:read");
      return null; // first-ever refresh for this ticker: no manifest, no watermark
    },
    loadNews: async () => {
      events.push("news:load");
      return [candidateArticle];
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
        articles: [candidateArticle],
        articleIds: [candidateArticle._id],
        contentFingerprint: "content-v1",
        analysisFingerprint: "analysis-v1",
      };
    },
    prepareAnalysis: async () => {
      events.push("analysis:prepare");
      return {
        labels: [
          {
            _id: candidateArticle._id,
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

test("worker: first cold refresh stages before upsert then clears via a successful 'published' publish", async () => {
  const events: string[] = [];
  let publishedDoc: AnalysisDoc | undefined;
  const result = await worker.runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    workerDeps(events, {
      publishAnalysis: async (doc) => {
        events.push("manifest:publish");
        publishedDoc = doc;
        return true;
      },
    })
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  assert.equal(result.outcome, "published");
  const stagingIndex = events.indexOf("staging:mark");
  const upsertIndex = events.indexOf("articles:upsert");
  const publishIndex = events.indexOf("manifest:publish");
  assert.ok(stagingIndex >= 0 && stagingIndex < upsertIndex);
  assert.ok(upsertIndex < publishIndex);
  // The worker hands the manifest doc to publishAnalysis without a staging
  // field of its own; clearing is publishAnalysisDoc's unconditional job
  // (proven separately by buildManifestPublishUpdate), not something the
  // worker needs to compute.
  assert.equal(publishedDoc?.refresh_staging_at, undefined);
});

test("worker: first cold refresh with zero news still stages before upsert and clears via 'no_news'", async () => {
  const events: string[] = [];
  const result = await worker.runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    workerDeps(events, {
      loadNews: async () => {
        events.push("news:load");
        return [];
      },
      upsert: async () => {
        events.push("articles:upsert");
        return { upserted: 0, inserted: 0, skippedAi: 0 };
      },
      selectCandidates: async () => {
        events.push("candidates:select");
        return {
          articles: [],
          articleIds: [],
          contentFingerprint: "empty-content",
          analysisFingerprint: "empty-analysis",
        };
      },
    })
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  assert.equal(result.outcome, "no_news");
  assert.deepEqual(events, [
    "analysis:read",
    "news:load",
    "staging:mark",
    "articles:upsert",
    "news:touch",
    "candidates:select",
    "manifest:publish",
    "cache:revalidate",
  ]);
});

test("worker: a subsequent refresh (existing manifest, stale news) still stages before its reused publish", async () => {
  const events: string[] = [];
  const staleCheckedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const result = await worker.runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    workerDeps(events, {
      readAnalysis: async () => {
        events.push("analysis:read");
        return {
          ticker: "AAPL",
          generation: 4,
          analysis_status: "complete",
          analysis_fingerprint: "analysis-v1",
          news_checked_at: staleCheckedAt,
          last_success_at: staleCheckedAt,
          published_article_ids: [candidateArticle._id],
        };
      },
      prepareAnalysis: async () => {
        throw new Error("Groq must not run for a reused fingerprint");
      },
    })
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  assert.equal(result.outcome, "reused");
  const stagingIndex = events.indexOf("staging:mark");
  const upsertIndex = events.indexOf("articles:upsert");
  const publishIndex = events.indexOf("manifest:publish");
  assert.ok(stagingIndex >= 0 && stagingIndex < upsertIndex);
  assert.ok(upsertIndex < publishIndex);
});

test("worker: a failed analysis pass after staging leaves the marker set (fails closed, does not publish)", async () => {
  const events: string[] = [];
  const result = await worker.runTickerRefreshJob(
    { ticker: "AAPL", workId: WORK_ID },
    workerDeps(events, {
      prepareAnalysis: async () => {
        events.push("analysis:prepare");
        throw new Error("provider timeout");
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(events.includes("staging:mark"), true);
  assert.equal(
    events.includes("manifest:publish"),
    false,
    "no publish means no chance to clear the marker; a no-manifest reader must stay fail-closed"
  );
});

// --- finalizer: the news-only fallback also clears staging via the same CAS publish ---

test("finalizer's news-only fallback for a never-published ticker publishes through the CAS path that clears staging", async () => {
  store.resetRefreshJobStoreForTests({
    now: () => NOW,
    createWorkId: () => WORK_ID,
  });
  const { job } = await store.reserveRefreshJob("orcl");
  await store.markRefreshJobRunning(job.workId, job.ticker);

  const events: string[] = [];
  let publishedDoc: AnalysisDoc | undefined;
  const current: AnalysisDoc = {
    ticker: "ORCL",
    generation: 0,
    refresh_staging_at: new Date(NOW + 30_000).toISOString(),
    news_loaded_at: new Date(NOW + 60_000).toISOString(),
  };

  await worker.finalizeFailedRefresh(
    { workId: job.workId, ticker: job.ticker },
    {
      getJob: async () => await store.getRefreshJob(job.workId),
      readAnalysis: async () => current,
      recordError: async () => {
        events.push("recordError");
      },
      selectCandidates: async () => {
        events.push("selectCandidates");
        return {
          articles: [candidateArticle],
          articleIds: [candidateArticle._id],
          contentFingerprint: "c",
          analysisFingerprint: "a",
        };
      },
      publishAnalysis: async (doc) => {
        events.push("publishAnalysis");
        publishedDoc = doc;
        return true;
      },
      acquireLock: async () => true,
      releaseLock: async () => true,
      isActiveOwner: async () => true,
      revalidateTicker: () => {
        events.push("revalidate");
      },
    }
  );

  assert.deepEqual(events, ["selectCandidates", "publishAnalysis", "revalidate"]);
  assert.equal(publishedDoc?.analysis_status, "unavailable");
  assert.deepEqual(publishedDoc?.published_article_ids, [candidateArticle._id]);

  store.resetRefreshJobStoreForTests();
});

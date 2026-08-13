import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisDoc, StoredArticle } from "../../src/lib/market-data/types";
import { buildManifestPublishUpdate } from "../../src/lib/market-data/news/store";
import {
  filterCommittedArticles,
  legacyFallbackAllowed,
} from "../../src/lib/market-intelligence/repository";

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

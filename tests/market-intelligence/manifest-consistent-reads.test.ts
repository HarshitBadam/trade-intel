import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPublishedArticleLabels,
  filterCommittedArticles,
} from "../../src/lib/market-intelligence/repository";
import { orderArticlesByManifest } from "../../src/lib/market-data/cache";
import type { AnalysisDoc, StoredArticle } from "../../src/lib/market-data/types";

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

test("homepage: manifest order/membership wins over whatever the store returns", () => {
  const published = ["art_two", "art_one"]; // deliberately out of storage order
  const staged = article("art_staged"); // never made it into the manifest
  const rowsFromStore = [article("art_one"), staged, article("art_two")];

  const visible = orderArticlesByManifest(published, rowsFromStore);

  assert.deepEqual(visible.map((row) => row._id), ["art_two", "art_one"]);
  assert.equal(
    visible.some((row) => row._id === "art_staged"),
    false,
    "a row outside the manifest must never be visible to the homepage"
  );
});

test("homepage: a row missing from the manifest fetch is simply absent, not substituted", () => {
  const published = ["art_missing", "art_one"];
  const rowsFromStore = [article("art_one")];

  const visible = orderArticlesByManifest(published, rowsFromStore);

  assert.deepEqual(visible.map((row) => row._id), ["art_one"]);
});

test("StockSage: rows staged after a failed refresh are excluded from evidence", () => {
  const lastSuccessAt = "2026-08-05T00:00:00.000Z";
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 3,
    last_success_at: lastSuccessAt,
    published_article_ids: ["art_committed"],
  };
  const committedHistoric = article("art_old", {
    ingested_at: "2026-05-01T00:00:00.000Z", // well before the watermark
  });
  const currentManifestRow = article("art_committed", {
    // Even if ingested after the watermark, the current manifest always wins.
    ingested_at: "2026-08-05T12:00:00.000Z",
  });
  const stagedAfterFailedRefresh = article("art_staged", {
    ingested_at: "2026-08-05T06:00:00.000Z", // after watermark, never published
  });

  const result = filterCommittedArticles(
    [committedHistoric, currentManifestRow, stagedAfterFailedRefresh],
    analysis
  );

  assert.deepEqual(
    result.map((row) => row._id).sort(),
    ["art_committed", "art_old"].sort()
  );
});

test("StockSage: 90-day committed history remains available, not just the 25 current display rows", () => {
  const lastSuccessAt = "2026-08-05T00:00:00.000Z";
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 3,
    last_success_at: lastSuccessAt,
    published_article_ids: ["art_current"],
  };
  const oldHistoric = article("art_89_days_ago", {
    ingested_at: "2026-05-08T00:00:00.000Z",
  });
  const current = article("art_current", {
    ingested_at: "2026-08-01T00:00:00.000Z",
  });

  const result = filterCommittedArticles([oldHistoric, current], analysis);

  assert.deepEqual(
    result.map((row) => row._id).sort(),
    ["art_89_days_ago", "art_current"]
  );
});

test("StockSage: no watermark yet (legacy/never-published ticker) falls back to unscoped read", () => {
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 0,
  };
  const rows = [article("art_a"), article("art_b")];

  const result = filterCommittedArticles(rows, analysis);

  assert.deepEqual(result.map((row) => row._id), ["art_a", "art_b"]);
});

test("manifest AI labels overlay onto evidence/homepage rows without mutating storage", () => {
  const original = article("art_one", {
    sentiment: "Neutral",
    importance: "Medium",
    key_observations: "",
  });
  const snapshotBefore = JSON.parse(JSON.stringify(original));
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 2,
    published_article_ids: ["art_one"],
    published_article_labels: [
      {
        article_id: "art_one",
        sentiment: "Positive",
        importance: "High",
        key_observations: "Beat on revenue.",
      },
    ],
  };

  const labeled = applyPublishedArticleLabels([original], analysis);

  assert.equal(labeled[0].metadata.sentiment, "Positive");
  assert.equal(labeled[0].metadata.importance, "High");
  assert.equal(labeled[0].metadata.key_observations, "Beat on revenue.");
  assert.deepEqual(original, snapshotBefore, "input article must not be mutated");
});

test("manifest labels overlay is a no-op when a row has no matching label", () => {
  const original = article("art_two");
  const analysis: AnalysisDoc = {
    ticker: "AAPL",
    generation: 2,
    published_article_ids: ["art_one"],
    published_article_labels: [
      {
        article_id: "art_one",
        sentiment: "Positive",
        importance: "High",
        key_observations: "Beat on revenue.",
      },
    ],
  };

  const labeled = applyPublishedArticleLabels([original], analysis);

  assert.deepEqual(labeled[0], original);
});

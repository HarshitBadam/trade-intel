import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { News, AnalysisDoc } from "../../src/lib/market-data/types";
import { buildNewsSummary } from "../../src/lib/market-data/queries";

const NOW = Date.parse("2026-08-08T08:00:00.000Z");
const current = new Date(NOW - 10 * 60 * 1000).toISOString();
const oldAnalysis = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();

const article: News = {
  _id: "article-one",
  page_content: "A current company update.",
  metadata: {
    title: "Company update",
    source: "Test Wire",
    publication_date: "2026-08-08T07:00:00.000Z",
    importance: "High",
    sentiment: "Positive",
    key_observations: "A current company update.",
    url: "https://example.com/update",
    ticker: "AAPL",
    description: "A current company update.",
    event: "Company update",
  },
};

function completeDoc(overrides: Partial<AnalysisDoc> = {}): AnalysisDoc {
  return {
    ticker: "AAPL",
    analysis_status: "complete",
    news_checked_at: current,
    concluded_at: current,
    analyzed_at: oldAnalysis,
    overall_sentiment: "Positive",
    summary: "Constructive.",
    ...overrides,
  };
}

test("fresh reused analysis displays the latest system conclusion", () => {
  const summary = buildNewsSummary([article], completeDoc(), false, NOW);

  assert.equal(summary.status, "fresh");
  assert.equal(summary.updatedAt, current);
  assert.equal(summary.verdict?.analyzedAt, oldAnalysis);
});

test("a current no-news conclusion is green and uses conclusion time", () => {
  const summary = buildNewsSummary(
    [],
    {
      ticker: "IBM",
      analysis_status: "no_news",
      news_checked_at: current,
      concluded_at: current,
      published_article_ids: [],
    },
    false,
    NOW
  );

  assert.equal(summary.status, "fresh");
  assert.equal(summary.updatedAt, current);
  assert.deepEqual(summary.news, []);
});

test("legacy worker documents fall back to last_success_at", () => {
  const summary = buildNewsSummary(
    [article],
    completeDoc({ concluded_at: undefined, last_success_at: current }),
    false,
    NOW
  );

  assert.equal(summary.status, "fresh");
  assert.equal(summary.updatedAt, current);
});

test("hard-expired conclusions do not expose old articles as current", () => {
  const expired = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();
  const summary = buildNewsSummary(
    [article],
    completeDoc({ concluded_at: expired, news_checked_at: expired }),
    false,
    NOW
  );

  assert.equal(summary.status, "hard_expired");
  assert.deepEqual(summary.news, []);
});

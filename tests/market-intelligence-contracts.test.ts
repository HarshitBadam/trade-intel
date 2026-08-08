import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnalysisFingerprint,
  createContentFingerprint,
  createContentRevision,
} from "../src/lib/market-intelligence/fingerprints";
import {
  NEWS_DEGRADED_AFTER_MS,
  NEWS_FRESH_FOR_MS,
  classifyMarketIntelligence,
} from "../src/lib/market-intelligence/freshness";
import {
  SHOWCASE_SYMBOLS,
  SHOWCASE_TICKERS,
} from "../src/lib/market-intelligence/showcase";
import { FALLBACK_TICKERS } from "../src/data/fallbacks/ticker-lists";
import { applyPublishedArticleLabels } from "../src/lib/market-intelligence/repository";
import type { StoredArticle } from "../src/lib/market-data/types";

const articles = [
  {
    articleId: "art_two",
    publicationDate: "2026-08-05T01:00:00Z",
    contentRevision: createContentRevision({
      title: "Second story",
      description: "A material update",
    }),
  },
  {
    articleId: "art_one",
    publicationDate: "2026-08-04T23:00:00Z",
    contentRevision: createContentRevision({
      title: "First story",
      pageContent: "Original report",
    }),
  },
];

test("content fingerprints are deterministic across article ordering", () => {
  const forward = createContentFingerprint(" nvda ", articles);
  const reversed = createContentFingerprint("NVDA", [...articles].reverse());

  assert.equal(forward, reversed);
  assert.match(forward, /^[a-f0-9]{64}$/);
  assert.notEqual(
    forward,
    createContentFingerprint("NVDA", [
      { ...articles[0], contentRevision: "revised" },
      articles[1],
    ])
  );
});

test("analysis fingerprints change with analysis inputs", () => {
  const contentFingerprint = createContentFingerprint("NVDA", articles);
  const baseline = createAnalysisFingerprint({
    contentFingerprint,
    promptVersion: "prompt-v1",
    model: "model-a",
  });

  assert.equal(
    baseline,
    createAnalysisFingerprint({
      contentFingerprint,
      promptVersion: "prompt-v1",
      model: "model-a",
    })
  );
  assert.notEqual(
    baseline,
    createAnalysisFingerprint({
      contentFingerprint,
      promptVersion: "prompt-v2",
      model: "model-a",
    })
  );
});

test("freshness uses the one-hour boundary", () => {
  const now = Date.parse("2026-08-05T03:00:00Z");
  const checkedAt = new Date(now - NEWS_FRESH_FOR_MS).toISOString();
  const base = {
    hasUsableContent: true,
    concludedAt: checkedAt,
    analysisFingerprint: "analysis-v1",
    expectedAnalysisFingerprint: "analysis-v1",
    now,
  };

  assert.equal(
    classifyMarketIntelligence({ ...base, newsCheckedAt: checkedAt }),
    "fresh"
  );
  assert.equal(
    classifyMarketIntelligence({
      ...base,
      concludedAt: new Date(now - NEWS_FRESH_FOR_MS - 1).toISOString(),
      newsCheckedAt: new Date(now - NEWS_FRESH_FOR_MS - 1).toISOString(),
    }),
    "stale"
  );
  assert.equal(
    classifyMarketIntelligence({
      ...base,
      newsCheckedAt: checkedAt,
      expectedAnalysisFingerprint: "analysis-v2",
    }),
    "stale"
  );
});

test("freshness hard-expires at 48 hours and preserves missing", () => {
  const now = Date.parse("2026-08-05T03:00:00Z");
  const expiredAt = new Date(now - NEWS_DEGRADED_AFTER_MS).toISOString();
  const base = {
    hasUsableContent: true,
    concludedAt: expiredAt,
    newsCheckedAt: expiredAt,
    now,
  };

  assert.equal(
    classifyMarketIntelligence({
      ...base,
      newsCheckedAt: expiredAt,
    }),
    "hard_expired"
  );
  assert.equal(
    classifyMarketIntelligence({
      ...base,
      concludedAt: new Date(now - NEWS_DEGRADED_AFTER_MS - 1).toISOString(),
      newsCheckedAt: new Date(now - NEWS_DEGRADED_AFTER_MS - 1).toISOString(),
    }),
    "hard_expired"
  );
  assert.equal(
    classifyMarketIntelligence({
      hasUsableContent: false,
      concludedAt: new Date(now).toISOString(),
      newsCheckedAt: new Date(now).toISOString(),
      now,
    }),
    "missing"
  );
});

test("freshness rejects future conclusions and degrades recorded failures", () => {
  const now = Date.parse("2026-08-05T03:00:00Z");
  const current = new Date(now).toISOString();

  assert.equal(
    classifyMarketIntelligence({
      hasUsableContent: true,
      concludedAt: new Date(now + 1).toISOString(),
      newsCheckedAt: current,
      now,
    }),
    "stale"
  );
  assert.equal(
    classifyMarketIntelligence({
      hasUsableContent: true,
      concludedAt: current,
      newsCheckedAt: current,
      lastErrorCode: "refresh_failed",
      now,
    }),
    "degraded"
  );
});

test("showcase tickers are canonical for existing fallbacks", () => {
  assert.deepEqual(SHOWCASE_SYMBOLS, [
    "AAPL",
    "MSFT",
    "NVDA",
    "TSLA",
    "AMZN",
    "GOOGL",
    "META",
    "NFLX",
    "AMD",
    "IBM",
  ]);
  assert.equal(FALLBACK_TICKERS, SHOWCASE_TICKERS);
});

test("published manifest labels overlay articles without mutating stored rows", () => {
  const stored: StoredArticle = {
    _id: "art_one",
    page_content: "Stored provider content",
    metadata: {
      title: "Update",
      source: "Wire",
      publication_date: "2026-08-05T01:00:00Z",
      sentiment: "Neutral",
      importance: "Low",
      key_observations: "",
      url: "https://example.com/update",
      ticker: "AAPL",
      description: "Stored provider content",
      event: "Update",
      label_source: "polygon",
    },
  };
  const [published] = applyPublishedArticleLabels([stored], {
    ticker: "AAPL",
    published_article_labels: [
      {
        article_id: "art_one",
        sentiment: "Positive",
        importance: "High",
        key_observations: "Validated observation",
      },
    ],
  });

  assert.equal(published.metadata.sentiment, "Positive");
  assert.equal(published.metadata.importance, "High");
  assert.equal(published.metadata.label_source, "ai");
  assert.equal(stored.metadata.sentiment, "Neutral");
});

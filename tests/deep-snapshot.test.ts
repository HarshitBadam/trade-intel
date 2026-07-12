import assert from "node:assert/strict";
import test from "node:test";
import { validateDeepResearchResult } from "../src/lib/stocksage/deep-validation";
import type { DeepResearchSnapshot } from "../src/lib/stocksage/deep-snapshot";

test("deep snapshot is signed, bounded, immutable, and tamper resistant", async () => {
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET =
    "test-only-snapshot-secret-with-sufficient-length";
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const {
    createDeepResearchOffer,
    parseDeepResearchSnapshot,
  } = await import("../src/lib/stocksage/deep-snapshot");
  const created = createDeepResearchOffer({
    question: "What happened to Apple today?",
    reply: {
      text: "Apple moved on validated market data.",
      live: true,
      citationUrls: ["https://example.com/apple"],
    },
    entities: [
      {
        id: "ticker:AAPL",
        name: "Apple",
        query: "Apple AAPL",
        ticker: "AAPL",
        market: "us",
      },
    ],
    state: {
      version: 1,
      revision: 3,
      entities: [],
      explicitEntitySet: ["ticker:AAPL"],
      criteria: ["performance"],
      horizon: "today",
      jurisdiction: "United States",
    },
    sources: [
      {
        id: "S1",
        kind: "tavily",
        title: "Apple update",
        outlet: "Example",
        url: "https://example.com/apple",
        excerpt: "Apple update",
        entityIds: ["ticker:AAPL"],
        criteria: ["performance"],
        retrievedAt: new Date().toISOString(),
      },
    ],
    asOf: new Date().toISOString(),
  });
  assert.ok(created.offer);
  const parsed = parseDeepResearchSnapshot(created.offer?.token);
  assert.equal(parsed?.responseId, created.responseId);
  assert.equal(parsed?.workId, created.offer?.workId);
  assert.equal(parsed?.question, "What happened to Apple today?");
  assert.equal(parsed?.regularAnswer, "Apple moved on validated market data.");
  assert.deepEqual(parsed?.evidenceIds, ["S1"]);
  assert.deepEqual(parsed?.criteria, ["performance"]);
  const token = created.offer?.token ?? "";
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(parseDeepResearchSnapshot(tampered), null);
});

test("deep result requires every entity and verifiable citations", () => {
  const snapshot: DeepResearchSnapshot = {
    version: 1,
    responseId: "1a7e28fa-b98a-4902-8226-17a7244f8750",
    workId: "6dbfcad2-95c4-452f-a10f-2aa0e69c44ba",
    question: "Compare the banks",
    regularAnswer: "Regular answer",
    evidenceIds: [],
    citationUrls: [],
    entities: [
      {
        id: "ticker:MQG",
        name: "Macquarie Group",
        ticker: "MQG",
        market: "web",
      },
      {
        id: "ticker:ANZ",
        name: "ANZ Group",
        ticker: "ANZ",
        market: "web",
      },
    ],
    criteria: ["performance"],
    asOf: "2026-07-11T00:00:00.000Z",
    stateVersion: 1,
    stateRevision: 1,
    createdAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-12T00:00:00.000Z",
  };
  assert.match(
    validateDeepResearchResult({
      snapshot,
      text: "Macquarie reported growth.",
      citationUrls: ["https://example.com/macquarie"],
    }) ?? "",
    /ANZ/
  );
  assert.match(
    validateDeepResearchResult({
      snapshot,
      text: "Macquarie and ANZ reported growth.",
      citationUrls: [],
    }) ?? "",
    /no verifiable citations/i
  );
  assert.equal(
    validateDeepResearchResult({
      snapshot,
      text: "Macquarie and ANZ reported growth.",
      citationUrls: ["https://example.com/banks"],
    }),
    null
  );
});

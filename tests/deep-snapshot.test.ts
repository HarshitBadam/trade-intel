import assert from "node:assert/strict";
import test from "node:test";
import { validateDeepResearchResult } from "../src/lib/stocksage/deep-validation";
import type { DeepResearchSnapshot } from "../src/lib/stocksage/deep-snapshot";
import type { EvidenceSource } from "../src/lib/stocksage/types";

function source(
  id: string,
  url: string,
  outlet: string,
  criteria: string[]
): EvidenceSource {
  return {
    id,
    kind: "tavily",
    title: `${outlet} Nvidia report`,
    outlet,
    url,
    excerpt: "Current reporting relevant to Nvidia investors.",
    entityIds: ["ticker:NVDA"],
    criteria,
    retrievedAt: new Date().toISOString(),
  };
}

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
  assert.equal(created.offer?.available, true);
  const token = created.offer?.token ?? "";
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(parseDeepResearchSnapshot(tampered), null);
});

test("deep pre-flight keeps a quote-only offer disabled with clear copy", async () => {
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET =
    "test-only-snapshot-secret-with-sufficient-length";
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const { createDeepResearchOffer } = await import(
    "../src/lib/stocksage/deep-snapshot"
  );
  const created = createDeepResearchOffer({
    question: "What is new with Rivian?",
    reply: { text: "Rivian is trading at a current quoted price.", live: true },
    entities: [
      {
        id: "ticker:RIVN",
        name: "Rivian",
        query: "Rivian RIVN",
        ticker: "RIVN",
        market: "us",
      },
    ],
    state: {
      version: 1,
      revision: 1,
      entities: [],
      explicitEntitySet: ["ticker:RIVN"],
      criteria: ["outlook"],
    },
    sources: [],
    asOf: new Date().toISOString(),
  });
  assert.ok(created.offer);
  assert.equal(created.offer?.available, false);
  assert.match(created.offer?.unavailableReason ?? "", /refreshing/i);
});

test("deep availability distinguishes broad reports from focused questions", async () => {
  const {
    assessDeepResearchAvailability,
    createDeepResearchOffer,
    isDeepResearchOfferAvailable,
  } = await import("../src/lib/stocksage/deep-snapshot");
  const skHynix = source(
    "S1",
    "https://example.com/sk-hynix-hbm?source=feed",
    "Example Markets",
    ["risk", "outlook"]
  );
  const broadQuestion = "Research Nvidia's next-quarter catalysts and risks.";
  const narrow = assessDeepResearchAvailability({
    question: broadQuestion,
    criteria: ["risk", "outlook"],
    sources: [skHynix],
  });
  assert.deepEqual(narrow, {
    available: false,
    reason: "insufficient_independent_sources",
    distinctSourceCount: 1,
    coveredCriteria: ["risk", "outlook"],
  });

  const broad = assessDeepResearchAvailability({
    question: broadQuestion,
    criteria: ["risk", "outlook"],
    sources: [
      skHynix,
      source(
        "S2",
        "https://another.example/nvidia-product-cycle",
        "Another Outlet",
        ["outlook", "risk"]
      ),
    ],
  });
  assert.equal(broad.available, true);
  assert.equal(broad.reason, "available_broad_evidence");
  assert.equal(broad.distinctSourceCount, 2);

  const focused = assessDeepResearchAvailability({
    question: "What regulatory risk matters most for Nvidia?",
    criteria: ["risk"],
    sources: [source("S1", "https://example.com/regulation", "Example", ["risk"])],
  });
  assert.deepEqual(focused, {
    available: true,
    reason: "available_single_criterion",
    distinctSourceCount: 1,
    coveredCriteria: ["risk"],
  });

  const offer = createDeepResearchOffer({
    question: broadQuestion,
    reply: { text: "A regular answer remains available.", live: true },
    entities: [
      {
        id: "ticker:NVDA",
        name: "Nvidia",
        query: "Nvidia",
        ticker: "NVDA",
        market: "us",
      },
    ],
    state: {
      version: 1,
      revision: 1,
      entities: [],
      explicitEntitySet: ["ticker:NVDA"],
      criteria: ["risk", "outlook"],
    },
    sources: [skHynix],
    asOf: new Date().toISOString(),
  });
  assert.equal(offer.offer?.available, false);
  assert.equal(
    offer.offer?.unavailableReason,
    "live research is refreshing — try again shortly"
  );
  assert.equal(isDeepResearchOfferAvailable(offer.offer), false);
});

test("deep availability requires coverage of every requested report criterion", async () => {
  const { assessDeepResearchAvailability } = await import(
    "../src/lib/stocksage/deep-snapshot"
  );
  const result = assessDeepResearchAvailability({
    question: "Research Nvidia's catalysts and risks.",
    criteria: ["risk", "outlook"],
    sources: [
      source("S1", "https://one.example/risk", "One", ["risk"]),
      source("S2", "https://two.example/competition", "Two", ["risk"]),
    ],
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "missing_criteria_coverage");
  assert.deepEqual(result.coveredCriteria, ["risk"]);
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

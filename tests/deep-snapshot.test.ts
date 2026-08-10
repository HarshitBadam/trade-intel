import "./no-live-keys";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { validateDeepResearchResult } from "../src/lib/stocksage/deep/validation";
import type { DeepResearchSnapshot } from "../src/lib/stocksage/deep/snapshot";
import type { EvidenceSource } from "../src/lib/stocksage/types";

const SNAPSHOT_SECRET = "test-only-snapshot-secret-with-sufficient-length";

function signedToken(snapshot: unknown): string {
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  const signature = createHmac("sha256", SNAPSHOT_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

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
    SNAPSHOT_SECRET;
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const {
    createDeepResearchOffer,
    parseDeepResearchSnapshot,
  } = await import("../src/lib/stocksage/deep/snapshot");
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
      groups: [
        {
          id: "group:mega-cap",
          label: "Mega Cap",
          memberIds: ["ticker:AAPL"],
          namedAtRevision: 3,
        },
      ],
      intervals: [
        {
          version: 1,
          label: "today",
          kind: "session",
          calendar: "US",
          startSession: "2026-08-05",
          endSession: "2026-08-05",
          source: "explicit",
          raw: "today",
        },
      ],
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
    queueReady: true,
  });
  assert.ok(created.offer);
  const parsed = parseDeepResearchSnapshot(created.offer?.token);
  assert.equal(parsed?.responseId, created.responseId);
  assert.equal(parsed?.workId, created.offer?.workId);
  assert.equal(parsed?.question, "What happened to Apple today?");
  assert.equal(parsed?.regularAnswer, "Apple moved on validated market data.");
  assert.deepEqual(parsed?.evidenceIds, ["S1"]);
  assert.deepEqual(parsed?.criteria, ["performance"]);
  assert.equal(parsed?.version, 2);
  assert.equal(parsed?.version === 2 ? parsed.route : null, "current_finance");
  assert.equal(parsed?.version === 2 ? parsed.entities[0].query : null, "Apple AAPL");
  assert.equal(parsed?.version === 2 ? parsed.calendar : null, "US");
  assert.equal(parsed?.version === 2 ? parsed.intervals.length : 0, 1);
  assert.equal(parsed?.version === 2 ? parsed.groups[0].id : null, "group:mega-cap");
  assert.equal(parsed?.stateRevision, 3);
  assert.equal(created.offer?.available, true);
  const token = created.offer?.token ?? "";
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(parseDeepResearchSnapshot(tampered), null);
});

test("v1 snapshots remain accepted until expiry and retries issue new v2 work", async () => {
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET = SNAPSHOT_SECRET;
  const {
    parseDeepResearchSnapshot,
    reissueDeepResearchSnapshot,
  } = await import("../src/lib/stocksage/deep/snapshot");
  const base = {
    version: 1 as const,
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
        market: "au" as const,
      },
    ],
    criteria: ["risk"],
    jurisdiction: "Australia",
    asOf: new Date().toISOString(),
    stateVersion: 1 as const,
    stateRevision: 4,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const parsed = parseDeepResearchSnapshot(signedToken(base));
  assert.equal(parsed?.version, 1);
  const retried = reissueDeepResearchSnapshot(parsed!);
  assert.equal(retried.snapshot.version, 2);
  assert.notEqual(retried.snapshot.workId, base.workId);
  assert.notEqual(retried.snapshot.attemptId, base.workId);
  assert.equal(retried.snapshot.parentWorkId, base.workId);
  assert.equal(retried.snapshot.attempt, 2);
  assert.equal(parseDeepResearchSnapshot(retried.token)?.workId, retried.snapshot.workId);

  assert.equal(
    parseDeepResearchSnapshot(
      signedToken({
        ...base,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      })
    ),
    null
  );
});

test("v2 obligation scope is signed, bounded, and preserved on retry", async () => {
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET = SNAPSHOT_SECRET;
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const {
    createDeepResearchOffer,
    parseDeepResearchSnapshot,
    reissueDeepResearchSnapshot,
  } = await import("../src/lib/stocksage/deep/snapshot");
  const interval = {
    version: 1 as const,
    label: "this quarter",
    kind: "range" as const,
    calendar: "US" as const,
    startSession: "2026-07-01",
    endSession: "2026-08-10",
    source: "explicit" as const,
  };
  const entity = {
    id: "ticker:AAPL",
    name: "Apple",
    query: "Apple AAPL",
    ticker: "AAPL",
    market: "us" as const,
  };
  const created = createDeepResearchOffer({
    question: "Research Apple's outlook.",
    reply: { text: "The regular answer is limited.", live: false },
    entities: [entity],
    state: {
      version: 2,
      revision: 2,
      entities: [entity],
      explicitEntitySet: [entity.id],
      criteria: [],
      focusEntityIds: [entity.id],
      intervals: [interval],
      frames: [],
      activeTemporalAnchors: [],
    },
    sources: [],
    asOf: new Date().toISOString(),
    queueReady: true,
    researchScope: {
      version: 1,
      obligations: [
        {
          id: "obligation:outlook",
          kind: "assess_outlook",
          query: "Apple risks and outlook this quarter",
          entityIds: [entity.id],
          intervals: [interval],
        },
      ],
    },
  });
  assert.ok(created.offer);
  const parsed = parseDeepResearchSnapshot(created.offer?.token);
  assert.equal(parsed?.version, 2);
  assert.equal(
    parsed?.version === 2
      ? parsed.researchScope?.obligations[0].kind
      : undefined,
    "assess_outlook"
  );
  const retried = reissueDeepResearchSnapshot(parsed!);
  assert.deepEqual(
    retried.snapshot.researchScope,
    parsed?.version === 2 ? parsed.researchScope : undefined
  );
  const reparsed = parseDeepResearchSnapshot(retried.token);
  assert.deepEqual(
    reparsed?.version === 2 ? reparsed.researchScope : undefined,
    retried.snapshot.researchScope
  );
});

test("Deep Research rejects an unresolved no-subject scope", async () => {
  const { createDeepResearchOffer } = await import(
    "../src/lib/stocksage/deep/snapshot"
  );
  const created = createDeepResearchOffer({
    question: "Research this more deeply.",
    reply: { text: "Please identify a company or index.", live: false },
    entities: [],
    state: {
      version: 1,
      revision: 0,
      entities: [],
      explicitEntitySet: [],
      criteria: ["risk"],
    },
    sources: [],
    asOf: new Date().toISOString(),
    queueReady: true,
  });
  assert.equal(created.offer, undefined);
});

test("deep pre-flight keeps a quote-only offer available for broader retrieval", async () => {
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET =
    "test-only-snapshot-secret-with-sufficient-length";
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const { createDeepResearchOffer } = await import(
    "../src/lib/stocksage/deep/snapshot"
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
    queueReady: true,
  });
  assert.ok(created.offer);
  assert.equal(created.offer?.available, true);
  assert.equal(created.offer?.unavailableReason, undefined);
});

test("Deep Research is not offered when the queue or turn capability is unavailable", async () => {
  const { createDeepResearchOffer } = await import(
    "../src/lib/stocksage/deep/snapshot"
  );
  const base = {
    question: "What is new with Apple?",
    reply: { text: "Apple has a supported regular answer.", live: true },
    entities: [
      {
        id: "ticker:AAPL",
        name: "Apple",
        query: "Apple AAPL",
        ticker: "AAPL",
        market: "us" as const,
      },
    ],
    state: {
      version: 1 as const,
      revision: 1,
      entities: [],
      explicitEntitySet: ["ticker:AAPL"],
      criteria: ["outlook"],
    },
    sources: [],
    asOf: new Date().toISOString(),
  };
  assert.equal(createDeepResearchOffer(base).offer, undefined);
  assert.equal(
    createDeepResearchOffer({
      ...base,
      queueReady: true,
      eligible: false,
    }).offer,
    undefined
  );
});

test("deep availability distinguishes broad reports from focused questions", async () => {
  const {
    assessDeepResearchAvailability,
    createDeepResearchOffer,
    isDeepResearchOfferAvailable,
  } = await import("../src/lib/stocksage/deep/snapshot");
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
    available: true,
    reason: "available_retrieval_needed",
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
    queueReady: true,
  });
  assert.equal(offer.offer?.available, true);
  assert.equal(offer.offer?.unavailableReason, undefined);
  assert.equal(isDeepResearchOfferAvailable(offer.offer), true);
});

test("deep availability requests missing report criteria during deeper retrieval", async () => {
  const { assessDeepResearchAvailability } = await import(
    "../src/lib/stocksage/deep/snapshot"
  );
  const result = assessDeepResearchAvailability({
    question: "Research Nvidia's catalysts and risks.",
    criteria: ["risk", "outlook"],
    sources: [
      source("S1", "https://one.example/risk", "One", ["risk"]),
      source("S2", "https://two.example/competition", "Two", ["risk"]),
    ],
  });
  assert.equal(result.available, true);
  assert.equal(result.reason, "available_retrieval_needed");
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

test("deep comparison preflight retrieves evidence missing for an entity", async () => {
  const { assessDeepResearchAvailability } = await import(
    "../src/lib/stocksage/deep/snapshot"
  );
  const result = assessDeepResearchAvailability({
    question: "Compare Tesla with the Nasdaq Composite this year.",
    criteria: [],
    entityIds: ["ticker:TSLA", "ticker:IXIC"],
    sources: [
      {
        ...source(
          "S1",
          "https://example.com/tesla",
          "Example",
          ["performance"]
        ),
        entityIds: ["ticker:TSLA"],
      },
    ],
  });
  assert.equal(result.available, true);
  assert.equal(result.reason, "available_retrieval_needed");
});

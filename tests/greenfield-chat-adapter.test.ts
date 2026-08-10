import assert from "node:assert/strict";
import test from "node:test";
import type { SemanticTurn } from "../src/lib/stocksage/greenfield/semantic-schema";
import type { SemanticModelRequest } from "../src/lib/stocksage/greenfield/semantic-interpreter";

process.env.STOCKSAGE_TELEMETRY = "quiet";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.TAVILY_API_KEY = "test-tavily-key";
process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET =
  "test-only-snapshot-secret-with-sufficient-length";
delete process.env.STOCKSAGE_ENGINE;
delete process.env.STOCKSAGE_GREENFIELD_CANARY_PERCENT;

function payload(request: SemanticModelRequest): {
  turnId: string;
  originalText: string;
} {
  return JSON.parse(request.user) as {
    turnId: string;
    originalText: string;
  };
}

function semanticTurn(
  request: SemanticModelRequest,
  overrides: Partial<SemanticTurn> = {}
): SemanticTurn {
  const input = payload(request);
  return {
    version: 1,
    turnId: input.turnId,
    originalText: input.originalText,
    intent: { kind: "social", confidence: 0.99 },
    informationNeeds: [],
    entities: {
      mentions: [],
      inheritance: {
        mode: "none",
        entityIds: [],
        orderedPositions: [],
        confidence: 0.99,
      },
      groupCandidates: [],
      confidence: 0.99,
    },
    comparison: {
      kind: "none",
      entityMentionIds: [],
      temporalSpecIds: [],
      confidence: 0.99,
    },
    metrics: [],
    temporal: { inherit: "none", specs: [], confidence: 0.99 },
    answer: { depth: "standard", format: "prose", confidence: 0.99 },
    topic: { mode: "continue", confidence: 0.99 },
    ambiguities: [],
    assumptions: [],
    corrections: [],
    confidence: 0.99,
    ...overrides,
  };
}

test("engine selection is legacy by default, overrideable, canaried, and v2-sticky", async () => {
  const { isGreenfieldCanarySession, selectStockSageEngine } = await import(
    "../src/lib/stocksage/chat"
  );
  const request = { message: "hello", history: [], sessionId: "session-a" };
  assert.equal(selectStockSageEngine(request), "legacy");
  assert.equal(selectStockSageEngine(request, { engine: "greenfield" }), "greenfield");
  assert.equal(selectStockSageEngine(request, { engine: "legacy" }), "legacy");
  assert.equal(isGreenfieldCanarySession("session-a", 0), false);
  assert.equal(isGreenfieldCanarySession("session-a", 100), true);
  assert.equal(
    isGreenfieldCanarySession("session-a", 37.5),
    isGreenfieldCanarySession("session-a", 37.5)
  );
  assert.equal(isGreenfieldCanarySession(undefined, 100), false);
  assert.equal(
    selectStockSageEngine(
      {
        ...request,
        state: {
          version: 2,
          revision: 1,
          entities: [],
          explicitEntitySet: [],
          criteria: [],
          focusEntityIds: [],
          frames: [],
          activeTemporalAnchors: [],
        },
      },
      { engine: "legacy" }
    ),
    "greenfield"
  );
});

test("adapter returns state v2, stable presentation fields, and budget telemetry", async () => {
  const [{ runGreenfieldChatAdapter }, telemetry] = await Promise.all([
    import("../src/lib/stocksage/greenfield/chat-adapter"),
    import("../src/lib/stocksage/telemetry"),
  ]);
  const events: import("../src/lib/stocksage/telemetry").StockSageEvent[] = [];
  const unsubscribe = telemetry.onStockSageEvent((event) => events.push(event));
  try {
    const reply = await runGreenfieldChatAdapter(
      {
        message: "Hello",
        history: [],
        state: {
          version: 1,
          revision: 2,
          entities: [],
          explicitEntitySet: [],
          criteria: [],
        },
      },
      {
        safetyClassifier: async () => ({ action: "allow" }),
        greenfield: {
          semanticModel: async (request) => semanticTurn(request),
        },
      }
    );
    assert.equal(reply.state?.version, 2);
    assert.equal(reply.state?.revision, 3);
    assert.equal(reply.presentationMode, "social");
    assert.equal(reply.dataStatus, "full");
    assert.equal(reply.live, false);
    const complete = events.find((event) => event.event === "request_complete");
    assert.equal(complete?.latencyClass, "regular");
    assert.equal(complete?.budgetMs, 5_000);
    assert.equal(complete?.dataStatus, "full");
    assert.match(complete?.detail ?? "", /forcedExecutionDepth/);
  } finally {
    unsubscribe();
  }
});

test("adapter emits choices only for a finite material ambiguity", async () => {
  const { runGreenfieldChatAdapter } = await import(
    "../src/lib/stocksage/greenfield/chat-adapter"
  );
  const reply = await runGreenfieldChatAdapter(
    { message: "Compare the Big Four", history: [] },
    {
      safetyClassifier: async () => ({ action: "allow" }),
      greenfield: {
        semanticModel: async (request) =>
          semanticTurn(request, {
            intent: { kind: "clarification", confidence: 0.9 },
            ambiguities: [
              {
                id: "big-four",
                field: "answer",
                reason: "The group is ambiguous.",
                candidates: [
                  "Australian Big Four banks",
                  "Big Four consultancies",
                ],
                requiresClarification: true,
                confidence: 0.99,
              },
            ],
          }),
      },
    }
  );
  assert.equal(reply.presentationMode, "clarification");
  assert.deepEqual(
    reply.clarificationChoices?.map((choice) => choice.label),
    ["Australian Big Four banks", "Big Four consultancies"]
  );
  assert.equal(reply.deepResearch, undefined);
});

test("deep narrative asks stay regular and receive a queued obligation snapshot", async () => {
  const [
    { runGreenfieldChatAdapter },
    { parseDeepResearchSnapshot },
    { InMemoryDocumentStore },
  ] = await Promise.all([
    import("../src/lib/stocksage/greenfield/chat-adapter"),
    import("../src/lib/stocksage/deep/snapshot"),
    import("../src/lib/stocksage/greenfield/documents"),
  ]);
  let inlineResearchCreates = 0;
  const reply = await runGreenfieldChatAdapter(
    { message: "Research Apple's current risks and outlook", history: [] },
    {
      safetyClassifier: async () => ({ action: "allow" }),
      deepQueueReady: true,
      greenfield: {
        semanticModel: async (request) =>
          semanticTurn(request, {
            intent: { kind: "outlook_research", confidence: 0.99 },
            informationNeeds: [
              {
                id: "risk",
                kind: "risk",
                question: "What risks and outlook matter for Apple?",
                priority: "primary",
              },
            ],
            entities: {
              mentions: [
                {
                  mentionId: "apple",
                  surface: "Apple",
                  canonicalName: "Apple",
                  ticker: "AAPL",
                  reference: "explicit",
                  role: "primary",
                  issuerOrInstrument: "issuer",
                  confidence: 0.99,
                },
              ],
              inheritance: {
                mode: "none",
                entityIds: [],
                orderedPositions: [],
                confidence: 0.99,
              },
              groupCandidates: [],
              confidence: 0.99,
            },
            answer: { depth: "deep", format: "prose", confidence: 0.99 },
          }),
        security: async () => null,
        documents: { store: new InMemoryDocumentStore() },
        researchPersistence: {
          async create() {
            inlineResearchCreates += 1;
            return true;
          },
          async save() {},
          async load() {
            return null;
          },
        },
      },
    }
  );
  assert.equal(inlineResearchCreates, 0);
  assert.ok(reply.deepResearch);
  assert.equal(reply.deepResearch?.available, true);
  assert.equal(reply.citationUrls, undefined);
  const snapshot = parseDeepResearchSnapshot(reply.deepResearch?.token);
  assert.equal(snapshot?.version, 2);
  assert.equal(snapshot?.version === 2 ? snapshot.researchScope?.version : null, 1);
  assert.deepEqual(
    snapshot?.version === 2
      ? snapshot.researchScope?.obligations[0].entityIds
      : null,
    ["ticker:AAPL"]
  );
  assert.match(
    snapshot?.version === 2
      ? snapshot.researchScope?.obligations[0].query ?? ""
      : "",
    /Apple/i
  );
});

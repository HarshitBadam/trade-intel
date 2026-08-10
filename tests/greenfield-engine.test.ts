import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { RangeBarSeries } from "../src/lib/market-data/range-bars";
import {
  runGreenfieldTurn,
  type GreenfieldDependencies,
} from "../src/lib/stocksage/greenfield/engine";
import {
  SemanticTurnSchema,
  type SemanticTurn,
} from "../src/lib/stocksage/greenfield/semantic-schema";
import type { SemanticModelRequest } from "../src/lib/stocksage/greenfield/semantic-interpreter";

const NOW = new Date("2026-08-09T10:00:00.000Z");

function semanticTurn(
  turnId: string,
  originalText: string,
  overrides: Partial<SemanticTurn> = {}
): SemanticTurn {
  return SemanticTurnSchema.parse({
    version: 1,
    turnId,
    originalText,
    intent: { kind: "entity_snapshot", confidence: 0.98 },
    informationNeeds: [
      {
        id: "price",
        kind: "price_performance",
        question: "What was the price performance?",
        priority: "primary",
      },
    ],
    entities: {
      mentions: [],
      inheritance: {
        mode: "none",
        entityIds: [],
        orderedPositions: [],
        confidence: 0.98,
      },
      groupCandidates: [],
      confidence: 0.98,
    },
    comparison: {
      kind: "none",
      entityMentionIds: [],
      temporalSpecIds: [],
      confidence: 0.98,
    },
    metrics: [],
    temporal: { inherit: "none", specs: [], confidence: 0.98 },
    answer: { depth: "standard", format: "prose", confidence: 0.98 },
    topic: { mode: "continue", confidence: 0.98 },
    ambiguities: [],
    assumptions: [],
    corrections: [],
    confidence: 0.98,
    ...overrides,
  });
}

function requestPayload(request: SemanticModelRequest): {
  turnId: string;
  originalText: string;
  semanticText: string;
  context: { activeEntities: { id: string }[] };
} {
  return JSON.parse(request.user) as {
    turnId: string;
    originalText: string;
    semanticText: string;
    context: { activeEntities: { id: string }[] };
  };
}

function mention(
  mentionId: string,
  name: string,
  ticker: string,
  role: "primary" | "comparison" = "primary"
) {
  return {
    mentionId,
    surface: name,
    canonicalName: name,
    ticker,
    reference: "explicit" as const,
    role,
    issuerOrInstrument: "issuer" as const,
    confidence: 0.99,
  };
}

function series(args: {
  ticker: string;
  start: string;
  end: string;
  unavailable?: boolean;
}): RangeBarSeries {
  const bars = args.unavailable
    ? []
    : [
        {
          timestamp: `${args.start}T20:00:00.000Z`,
          session: args.start,
          open: 90,
          high: 91,
          low: 89,
          close: 90,
          volume: 1_000,
        },
        {
          timestamp: `${args.end}T20:00:00.000Z`,
          session: args.end,
          open: 99,
          high: 101,
          low: 98,
          close: 100,
          volume: 1_200,
        },
      ];
  return {
    ticker: args.ticker,
    instrumentSymbol: args.ticker,
    venue: "US",
    calendar: "US",
    granularity: "1Day",
    adjusted: true,
    requestStart: args.start,
    requestEnd: args.end,
    bars,
    status: args.unavailable ? "unavailable" : "complete",
    ...(args.unavailable ? { reason: "no_data" as const } : {}),
    expectedSessions: [args.start, args.end],
    missingSessions: args.unavailable ? [args.start, args.end] : [],
    attemptedProviders: ["polygon"],
    cacheKey: `test:${args.ticker}:${args.start}:${args.end}`,
  };
}

const groundedComposer: NonNullable<GreenfieldDependencies["composer"]> = {
  async compose(input) {
    const evidence = input.evidence.find(
      (item) => typeof item.facts?.close?.value === "number"
    );
    assert.ok(evidence);
    return {
      claims: [
        {
          id: "grounded-price",
          text: `${evidence.instrument} closed at ${evidence.facts?.close.value}.`,
          kind: "factual",
          evidenceIds: [evidence.id],
          factRefs: [{ evidenceId: evidence.id, factKey: "close" }],
          instrument: evidence.instrument,
          currency: evidence.currency,
          periodStart: evidence.periodStart,
          periodEnd: evidence.periodEnd,
        },
      ],
    };
  },
};

test("vertical slice carries plural entity context into a three-week follow-up", async () => {
  const semanticModel = async (request: SemanticModelRequest) => {
    const payload = requestPayload(request);
    if (payload.originalText.startsWith("whsta")) {
      return semanticTurn(payload.turnId, payload.originalText, {
        intent: { kind: "entity_comparison", confidence: 0.99 },
        entities: {
          mentions: [
            mention("spacex", "SpaceX", "SPCX"),
            mention("tesla", "Tesla", "TSLA", "comparison"),
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
        comparison: {
          kind: "entity_vs_entity",
          entityMentionIds: ["spacex", "tesla"],
          temporalSpecIds: [],
          confidence: 0.99,
        },
      });
    }
    return semanticTurn(payload.turnId, payload.originalText, {
      intent: { kind: "entity_comparison", confidence: 0.99 },
      entities: {
        mentions: [],
        inheritance: {
          mode: "all_active",
          entityIds: payload.context.activeEntities.map((entity) => entity.id),
          orderedPositions: [],
          confidence: 0.99,
        },
        groupCandidates: [],
        confidence: 0.99,
      },
      comparison: {
        kind: "none",
        entityMentionIds: [],
        temporalSpecIds: ["three-weeks"],
        confidence: 0.99,
      },
      temporal: {
        inherit: "none",
        specs: [
          {
            id: "three-weeks",
            kind: "point",
            label: "three weeks ago",
            value: {
              type: "relative",
              unit: "week",
              amount: 3,
              direction: "past",
            },
            source: "explicit",
            confidence: 0.99,
          },
        ],
        confidence: 0.99,
      },
    });
  };
  const dependencies: GreenfieldDependencies = {
    semanticModel,
    composer: groundedComposer,
    market: async (need) =>
      series({
        ticker: need.entity.ticker as string,
        start: need.fetchStartSession,
        end: need.fetchEndSession,
      }),
    security: async () => null,
  };

  const initial = await runGreenfieldTurn(
    { message: "whsta up with SpaceX vs Tesla", now: NOW },
    dependencies
  );
  assert.equal(initial.kind, "answer");
  assert.deepEqual(
    initial.trace.plan?.entities.map((entity) => entity.ticker),
    ["SPCX", "TSLA"]
  );

  const followUp = await runGreenfieldTurn(
    {
      message: "How were thye like 3 weeks ago",
      now: NOW,
      ledger: initial.ledger,
    },
    dependencies
  );
  assert.equal(followUp.kind, "answer");
  assert.deepEqual(
    followUp.trace.plan?.entities.map((entity) => entity.ticker),
    ["SPCX", "TSLA"]
  );
  assert.deepEqual(
    followUp.trace.plan?.intervals.map((interval) => [
      interval.startSession,
      interval.endSession,
    ]),
    [["2026-07-17", "2026-07-17"]]
  );
  assert.match(followUp.trace.plan?.standaloneQuery ?? "", /SpaceX/);
  assert.match(followUp.trace.plan?.standaloneQuery ?? "", /Tesla/);
  assert.match(followUp.trace.plan?.standaloneQuery ?? "", /2026-07-17/);
});

test("five-versus-seven-years plans separate point windows and never substitutes current bars", async () => {
  const semanticModel = async (request: SemanticModelRequest) => {
    const payload = requestPayload(request);
    return semanticTurn(payload.turnId, payload.originalText, {
      intent: { kind: "entity_comparison", confidence: 0.99 },
      entities: {
        mentions: [mention("macquarie", "Macquarie Group", "MQG")],
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
        kind: "time_vs_time",
        entityMentionIds: ["macquarie"],
        temporalSpecIds: ["five-seven"],
        confidence: 0.99,
      },
      temporal: {
        inherit: "none",
        specs: [
          {
            id: "five-seven",
            kind: "comparison",
            label: "five versus seven years ago",
            left: {
              kind: "point",
              label: "five years ago",
              value: {
                type: "relative",
                unit: "year",
                amount: 5,
                direction: "past",
              },
            },
            right: {
              kind: "point",
              label: "seven years ago",
              value: {
                type: "relative",
                unit: "year",
                amount: 7,
                direction: "past",
              },
            },
            source: "explicit",
            confidence: 0.99,
          },
        ],
        confidence: 0.99,
      },
    });
  };
  const requestedRanges: string[] = [];
  const response = await runGreenfieldTurn(
    { message: "How was Macquarie 5 vs 7 years ago?", now: NOW },
    {
      semanticModel,
      composer: groundedComposer,
      market: async (need) => {
        requestedRanges.push(`${need.fetchStartSession}:${need.fetchEndSession}`);
        return series({
          ticker: "MQG",
          start: need.fetchStartSession,
          end: need.fetchEndSession,
          unavailable: true,
        });
      },
      security: async () => null,
    }
  );

  assert.equal(response.kind, "unavailable");
  assert.deepEqual(
    response.trace.plan?.intervals.map((interval) => interval.startSession),
    ["2021-08-06", "2019-08-07"]
  );
  assert.equal(requestedRanges.length, 2);
  assert.ok(requestedRanges.every((range) => !range.includes("2026-08")));
  assert.match(response.text, /No current-period figure was substituted/);
});

test("material semantic ambiguity asks one clarification before any retrieval", async () => {
  let calls = 0;
  const response = await runGreenfieldTurn(
    { message: "compare the big four", now: NOW },
    {
      semanticModel: async (request) => {
        const payload = requestPayload(request);
        return semanticTurn(payload.turnId, payload.originalText, {
          intent: { kind: "entity_comparison", confidence: 0.7 },
          informationNeeds: [
            {
              id: "compare",
              kind: "comparison",
              question: "Which Big Four group?",
              priority: "primary",
            },
          ],
          ambiguities: [
            {
              id: "which-big-four",
              field: "group",
              reason: "“Big Four” could mean banks or consultancies.",
              candidates: ["Australian Big Four banks", "Big Four consultancies"],
              requiresClarification: true,
              confidence: 0.99,
            },
          ],
        });
      },
      market: async (need) => {
        calls += 1;
        return series({
          ticker: need.entity.ticker as string,
          start: need.fetchStartSession,
          end: need.fetchEndSession,
        });
      },
    }
  );

  assert.equal(response.kind, "clarification");
  assert.equal(calls, 0);
  assert.match(response.text, /banks or consultancies/);
});

test("crisis handling remains an input safety boundary before the semantic model", async () => {
  let modelCalls = 0;
  const response = await runGreenfieldTurn(
    { message: "I am going to kill myself", now: NOW },
    {
      semanticModel: async () => {
        modelCalls += 1;
        throw new Error("must not run");
      },
    }
  );
  assert.equal(response.kind, "safety_support");
  assert.equal(modelCalls, 0);
  assert.match(response.text, /emergency services/);
});

test("typo later resolves to latter SpaceX versus IXIC without clarification", async () => {
  const marketTickers: string[] = [];
  const semanticModel = async (request: SemanticModelRequest) => {
    const payload = requestPayload(request);
    if (/tesla vs spacex/i.test(payload.originalText)) {
      return semanticTurn(payload.turnId, payload.originalText, {
        intent: { kind: "entity_comparison", confidence: 0.99 },
        entities: {
          mentions: [
            mention("tesla", "Tesla", "TSLA"),
            mention("spacex", "SpaceX", "SPCX", "comparison"),
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
        comparison: {
          kind: "entity_vs_entity",
          entityMentionIds: ["tesla", "spacex"],
          temporalSpecIds: [],
          confidence: 0.99,
        },
      });
    }

    assert.match(payload.semanticText, /\bthe latter\b/i);
    assert.deepEqual(
      payload.context.activeEntities.map((entity) => entity.id),
      ["ticker:TSLA", "ticker:SPCX"]
    );
    return semanticTurn(payload.turnId, payload.originalText, {
      intent: { kind: "entity_comparison", confidence: 0.99 },
      entities: {
        mentions: [
          {
            mentionId: "latter-ref",
            surface: "later",
            canonicalName: "latter",
            reference: "ordered",
            role: "primary",
            issuerOrInstrument: "issuer",
            confidence: 0.99,
          },
          mention("ixic", "Nasdaq Composite", "IXIC", "comparison"),
        ],
        inheritance: {
          mode: "none",
          entityIds: [],
          orderedPositions: ["latter"],
          confidence: 0.99,
        },
        groupCandidates: [],
        confidence: 0.99,
      },
      comparison: {
        kind: "entity_vs_entity",
        entityMentionIds: ["latter-ref", "ixic"],
        temporalSpecIds: [],
        confidence: 0.99,
      },
    });
  };

  const dependencies: GreenfieldDependencies = {
    semanticModel,
    market: async (need) => {
      marketTickers.push(need.entity.ticker as string);
      return series({
        ticker: need.entity.ticker as string,
        start: need.fetchStartSession,
        end: need.fetchEndSession,
      });
    },
    security: async () => null,
    composer: async () => {
      throw new Error("deterministic comparison should not need the LLM composer");
    },
  };

  const initial = await runGreenfieldTurn(
    { message: "aight so whats up with tesla vs SpaceX", now: NOW },
    dependencies
  );
  assert.equal(initial.kind, "answer");
  assert.deepEqual(
    initial.trace.plan?.entities.map((entity) => entity.ticker),
    ["TSLA", "SPCX"]
  );

  marketTickers.length = 0;
  const followUp = await runGreenfieldTurn(
    {
      message: "whats up with the later vs IXIC",
      now: NOW,
      ledger: initial.ledger,
    },
    dependencies
  );

  assert.equal(followUp.kind, "answer");
  assert.notEqual(followUp.kind, "clarification");
  assert.deepEqual(
    followUp.trace.plan?.entities.map((entity) => entity.ticker),
    ["SPCX", "IXIC"]
  );
  assert.deepEqual([...new Set(marketTickers)].sort(), ["IXIC", "SPCX"]);
  assert.match(followUp.trace.plan?.standaloneQuery ?? "", /SpaceX|SPCX/);
  assert.match(followUp.trace.plan?.standaloneQuery ?? "", /IXIC|Nasdaq/);
});

test("Tesla versus private StockX answers without clarification and listing follow-up skips retrieval", async () => {
  let marketCalls = 0;
  let securityCalls = 0;
  let composerCalls = 0;
  const semanticModel = async (request: SemanticModelRequest) => {
    const payload = requestPayload(request);
    if (/tesla vs stockx/i.test(payload.originalText)) {
      return semanticTurn(payload.turnId, payload.originalText, {
        intent: { kind: "entity_comparison", confidence: 0.99 },
        entities: {
          mentions: [
            mention("tesla", "Tesla", "TSLA"),
            {
              mentionId: "stockx",
              surface: "StockX",
              canonicalName: "StockX",
              reference: "explicit",
              role: "comparison",
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
        comparison: {
          kind: "entity_vs_entity",
          entityMentionIds: ["tesla", "stockx"],
          temporalSpecIds: [],
          confidence: 0.99,
        },
        ambiguities: [
          {
            id: "stockx-identity",
            field: "entity",
            reason: "StockX could be confused with a ticker symbol.",
            candidates: ["StockX private company", "an unrelated ticker"],
            requiresClarification: true,
            confidence: 0.7,
          },
        ],
      });
    }

    assert.deepEqual(
      payload.context.activeEntities.map((entity) => entity.id).sort(),
      ["name:stockx", "ticker:TSLA"]
    );
    return semanticTurn(payload.turnId, payload.originalText, {
      intent: { kind: "entity_comparison", confidence: 0.99 },
      informationNeeds: [
        {
          id: "buyable",
          kind: "listing_status",
          question: "Which of the active entities can be bought on an exchange?",
          priority: "primary",
        },
      ],
      entities: {
        mentions: [],
        inheritance: {
          mode: "all_active",
          entityIds: payload.context.activeEntities.map((entity) => entity.id),
          orderedPositions: [],
          confidence: 0.99,
        },
        groupCandidates: [],
        confidence: 0.99,
      },
      ambiguities: [
        {
          id: "which-listing",
          field: "entity",
          reason: "Which company listing should be checked?",
          candidates: ["Tesla", "StockX"],
          requiresClarification: true,
          confidence: 0.6,
        },
      ],
    });
  };

  const dependencies: GreenfieldDependencies = {
    semanticModel,
    market: async (need) => {
      marketCalls += 1;
      return series({
        ticker: need.entity.ticker as string,
        start: need.fetchStartSession,
        end: need.fetchEndSession,
      });
    },
    security: async () => {
      securityCalls += 1;
      return null;
    },
    composer: async () => {
      composerCalls += 1;
      throw new Error("deterministic private comparison should not need the LLM composer");
    },
  };

  const initial = await runGreenfieldTurn(
    { message: "How's Tesla vs StockX doing?", now: NOW },
    dependencies
  );
  assert.equal(initial.kind, "answer");
  assert.notEqual(initial.kind, "clarification");
  assert.deepEqual(
    initial.trace.plan?.entities.map((entity) => entity.id).sort(),
    ["name:stockx", "ticker:TSLA"]
  );
  assert.equal(
    initial.trace.plan?.entities.find((entity) => entity.id === "name:stockx")
      ?.private,
    true
  );
  assert.match(initial.text, /StockX is privately held/i);
  assert.match(initial.text, /no public-market price return/i);
  assert.ok(marketCalls >= 1);
  assert.equal(composerCalls, 0);

  const marketBeforeFollowUp = marketCalls;
  const securityBeforeFollowUp = securityCalls;
  const followUp = await runGreenfieldTurn(
    {
      message: "which one can I buy on an exchange?",
      now: NOW,
      ledger: initial.ledger,
    },
    dependencies
  );

  assert.equal(followUp.kind, "answer");
  assert.notEqual(followUp.kind, "clarification");
  assert.deepEqual(
    followUp.trace.plan?.obligations.map((obligation) => obligation.kind),
    ["verify_listing"]
  );
  assert.equal(marketCalls, marketBeforeFollowUp);
  assert.equal(securityCalls, securityBeforeFollowUp);
  assert.match(followUp.text, /Tesla is publicly traded as TSLA/i);
  assert.match(
    followUp.text,
    /StockX is privately held, so it has no public exchange ticker to buy/i
  );
});

test("correction-only index pivot acknowledges Tesla without planning or providers", async () => {
  let marketCalls = 0;
  let securityCalls = 0;
  const semanticModel = async (request: SemanticModelRequest) => {
    const payload = requestPayload(request);
    if (/tesla vs ixic/i.test(payload.originalText)) {
      return semanticTurn(payload.turnId, payload.originalText, {
        intent: { kind: "entity_comparison", confidence: 0.99 },
        entities: {
          mentions: [
            mention("tesla", "Tesla", "TSLA"),
            mention("ixic", "Nasdaq Composite", "IXIC", "comparison"),
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
        comparison: {
          kind: "entity_vs_entity",
          entityMentionIds: ["tesla", "ixic"],
          temporalSpecIds: [],
          confidence: 0.99,
        },
      });
    }

    return semanticTurn(payload.turnId, payload.originalText, {
      intent: { kind: "correction", confidence: 0.99 },
      informationNeeds: [],
      entities: {
        mentions: [mention("tesla", "Tesla", "TSLA")],
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
      topic: { mode: "pivot", label: "Tesla", confidence: 0.99 },
      corrections: [
        {
          id: "drop-index",
          field: "entity",
          operation: "remove",
          targetId: "ticker:IXIC",
          confidence: 0.99,
        },
      ],
    });
  };

  const dependencies: GreenfieldDependencies = {
    semanticModel,
    market: async (need) => {
      marketCalls += 1;
      return series({
        ticker: need.entity.ticker as string,
        start: need.fetchStartSession,
        end: need.fetchEndSession,
      });
    },
    security: async () => {
      securityCalls += 1;
      return null;
    },
    composer: async () => {
      throw new Error("correction-only pivot must not call the composer");
    },
  };

  const initial = await runGreenfieldTurn(
    { message: "Compare Tesla vs IXIC", now: NOW },
    dependencies
  );
  assert.equal(initial.kind, "answer");
  assert.deepEqual(
    initial.trace.plan?.entities.map((entity) => entity.ticker),
    ["TSLA", "IXIC"]
  );

  const marketBeforePivot = marketCalls;
  const securityBeforePivot = securityCalls;
  const pivot = await runGreenfieldTurn(
    {
      message: "forget the index — just Tesla",
      now: NOW,
      ledger: initial.ledger,
    },
    dependencies
  );

  assert.equal(pivot.kind, "answer");
  assert.equal(pivot.trace.plan, undefined);
  assert.equal(marketCalls, marketBeforePivot);
  assert.equal(securityCalls, securityBeforePivot);
  assert.match(pivot.text, /Got it/i);
  assert.match(pivot.text, /Tesla/);
  assert.doesNotMatch(pivot.text, /IXIC|Nasdaq/i);
  assert.deepEqual(
    pivot.ledger.entries.at(-1)?.state.entities.map((entity) => entity.ticker),
    ["TSLA"]
  );
});

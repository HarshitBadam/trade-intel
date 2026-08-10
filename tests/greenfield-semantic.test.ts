import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendConversationTurn,
  createConversationLedger,
  ledgerInterpreterContext,
} from "../src/lib/stocksage/greenfield/conversation-ledger";
import {
  compileTemporalSpecs,
  createSemanticInterpreter,
  groundSemanticTurn,
  rewriteContextualQuery,
  type SemanticInterpretation,
  type SemanticInterpreterContext,
  type SemanticModelRequest,
} from "../src/lib/stocksage/greenfield/semantic-interpreter";
import {
  SemanticTurnSchema,
  type SemanticTurn,
} from "../src/lib/stocksage/greenfield/semantic-schema";
import { expandSemanticExtraction } from "../src/lib/stocksage/greenfield/semantic-wire";

function semanticTurn(
  turnId: string,
  originalText: string,
  overrides: Partial<SemanticTurn> = {}
): SemanticTurn {
  return SemanticTurnSchema.parse({
    version: 1,
    turnId,
    originalText,
    intent: { kind: "entity_snapshot", confidence: 0.95 },
    informationNeeds: [],
    entities: {
      mentions: [],
      inheritance: {
        mode: "none",
        entityIds: [],
        orderedPositions: [],
        confidence: 0.95,
      },
      groupCandidates: [],
      confidence: 0.95,
    },
    comparison: {
      kind: "none",
      entityMentionIds: [],
      temporalSpecIds: [],
      confidence: 0.95,
    },
    metrics: [],
    temporal: { inherit: "none", specs: [], confidence: 0.95 },
    answer: { depth: "standard", format: "prose", confidence: 0.9 },
    topic: { mode: "continue", confidence: 0.9 },
    ambiguities: [],
    assumptions: [],
    corrections: [],
    confidence: 0.94,
    ...overrides,
  });
}

function interpretation(
  semantic: SemanticTurn,
  context?: SemanticInterpreterContext
): SemanticInterpretation {
  const grounding = groundSemanticTurn(semantic, context);
  const compiledTemporal = compileTemporalSpecs(semantic.temporal.specs, {
    now: new Date("2026-08-09T20:00:00.000Z"),
    calendar: "US",
  });
  return {
    semantic,
    grounding,
    compiledTemporal,
    standaloneQuery: rewriteContextualQuery(
      semantic,
      grounding,
      context,
      compiledTemporal
    ),
  };
}

const TESLA = {
  id: "ticker:TSLA",
  name: "Tesla",
  query: "Tesla TSLA stock financial news",
  ticker: "TSLA",
  market: "us" as const,
};

const SPACEX = {
  id: "ticker:SPCX",
  name: "SpaceX",
  query: "SpaceX SPCX stock financial news",
  ticker: "SPCX",
  market: "us" as const,
};

const IXIC = {
  id: "ticker:IXIC",
  name: "Nasdaq Composite",
  query: "Nasdaq Composite IXIC market index",
  ticker: "IXIC",
  market: "index" as const,
};

test("semantic schema is strict across meaning and temporal comparison fields", () => {
  const valid = semanticTurn("strict-1", "Compare Apple now with last month", {
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
        {
          mentionId: "apple-history",
          surface: "Apple",
          canonicalName: "Apple",
          ticker: "AAPL",
          reference: "explicit",
          role: "comparison",
          issuerOrInstrument: "instrument",
          confidence: 0.98,
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
      kind: "entity_and_time",
      entityMentionIds: ["apple", "apple-history"],
      temporalSpecIds: ["window-comparison"],
      confidence: 0.98,
    },
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "window-comparison",
          kind: "comparison",
          label: "now versus last month",
          left: {
            kind: "point",
            label: "now",
            value: { type: "absolute", date: "2026-08-07" },
          },
          right: {
            kind: "range",
            label: "last month",
            start: { type: "absolute", date: "2026-07-01" },
            end: { type: "absolute", date: "2026-07-31" },
          },
          source: "explicit",
          confidence: 0.98,
        },
      ],
      confidence: 0.98,
    },
  });
  assert.equal(valid.comparison.kind, "entity_and_time");
  assert.equal(valid.temporal.specs[0].kind, "comparison");

  assert.throws(
    () => SemanticTurnSchema.parse({ ...valid, answerText: "Apple went up." }),
    /Unrecognized key/
  );
  assert.throws(
    () =>
      SemanticTurnSchema.parse({
        ...valid,
        comparison: {
          ...valid.comparison,
          entityMentionIds: ["missing", "apple"],
        },
      }),
    /Unknown entity mention id/
  );
});

test("interpreter uses the injected JSON seam, validates, grounds, and rewrites", async () => {
  const context: SemanticInterpreterContext = {
    activeEntities: [TESLA],
    activeGroups: [],
    activeTemporal: [],
    recentTurnIds: ["turn-1"],
  };
  const output = semanticTurn("turn-2", "How did it do last month?", {
    informationNeeds: [
      {
        id: "performance",
        kind: "price_performance",
        question: "Tesla price performance over last month",
        priority: "primary",
      },
    ],
    entities: {
      mentions: [],
      inheritance: {
        mode: "singular",
        sourceTurnId: "turn-1",
        entityIds: ["ticker:TSLA"],
        orderedPositions: [],
        confidence: 0.99,
      },
      groupCandidates: [],
      confidence: 0.99,
    },
    metrics: [
      {
        id: "return",
        name: "price return",
        operation: "percentage_change",
        unit: "percent",
        confidence: 0.95,
      },
    ],
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "last-month",
          kind: "range",
          label: "last month",
          start: {
            type: "relative",
            unit: "month",
            amount: 1,
            direction: "past",
          },
          end: {
            type: "relative",
            unit: "day",
            amount: 0,
            direction: "past",
          },
          source: "explicit",
          confidence: 0.99,
        },
      ],
      confidence: 0.99,
    },
  });
  let request: SemanticModelRequest | undefined;
  const interpreter = createSemanticInterpreter(async (input) => {
    request = input;
    return output;
  });
  const result = await interpreter({
    turnId: "turn-2",
    message: "How did it do last month?",
    now: new Date("2026-08-09T20:00:00.000Z"),
    calendar: "US",
    context,
  });

  assert.match(request?.system ?? "", /never answer/i);
  assert.match(request?.system ?? "", /Never calculate or emit resolved dates/i);
  assert.match(request?.user ?? "", /australian-big-four/);
  assert.match(request?.user ?? "", /"marketCalendar":"US"/);
  assert.match(request?.user ?? "", /2026-08-09T20:00:00.000Z/);
  assert.deepEqual(
    result.grounding.inheritedEntities.map((entity) => entity.ticker),
    ["TSLA"]
  );
  assert.match(result.standaloneQuery, /Tesla \(TSLA\)/);
  assert.match(result.standaloneQuery, /2026-07-07 through 2026-08-07/);
  assert.match(result.standaloneQuery, /price return/);
  assert.equal(result.compiledTemporal[0].intervals[0].calendar, "US");

  const invalidInterpreter = createSemanticInterpreter(async () => ({
    ...output,
    unsupportedAnswer: "Buy it.",
  }));
  await assert.rejects(
    () =>
      invalidInterpreter({
        turnId: "turn-2",
        message: "How did it do last month?",
        now: new Date("2026-08-09T20:00:00.000Z"),
        calendar: "US",
        context,
      }),
    /Unrecognized key/
  );
});

test("last few months remains a reversible three-month semantic assumption", () => {
  const turn = semanticTurn("relative-few-months", "How has Tesla done over the last few months?", {
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "few-months",
          kind: "range",
          label: "last few months",
          start: {
            type: "relative",
            unit: "month",
            amount: 3,
            direction: "past",
          },
          end: {
            type: "relative",
            unit: "day",
            amount: 0,
            direction: "past",
          },
          assumptionId: "few-means-three",
          source: "explicit",
          confidence: 0.85,
        },
      ],
      confidence: 0.85,
    },
    assumptions: [
      {
        id: "few-means-three",
        field: "temporal",
        value: "Interpret few months as a trailing three-month range.",
        reason: "The user did not specify an exact number of months.",
        confidence: 0.85,
      },
    ],
  });
  const compiled = compileTemporalSpecs(turn.temporal.specs, {
    now: new Date("2026-08-09T20:00:00.000Z"),
    calendar: "US",
  });

  assert.equal(turn.temporal.specs[0].kind, "range");
  assert.equal(
    turn.temporal.specs[0].kind === "range"
      ? turn.temporal.specs[0].assumptionId
      : undefined,
    "few-means-three"
  );
  assert.deepEqual(compiled[0].intervals[0], {
    version: 1,
    label: "last few months",
    kind: "range",
    calendar: "US",
    startSession: "2026-05-07",
    endSession: "2026-08-07",
    source: "explicit",
    raw: "last few months",
  });
  assert.equal(compiled[0].assumptionId, "few-means-three");

  assert.throws(
    () => SemanticTurnSchema.parse({ ...turn, assumptions: [] }),
    /Unknown temporal assumption id/
  );
  assert.throws(
    () =>
      SemanticTurnSchema.parse({
        ...turn,
        temporal: {
          ...turn.temporal,
          specs: [
            {
              ...turn.temporal.specs[0],
              start: {
                type: "relative",
                unit: "month",
                amount: 3,
                direction: "past",
                resolvedDate: "2026-05-07",
              },
            },
          ],
        },
      }),
    /Unrecognized key/,
    "relative offsets cannot smuggle model-calculated dates"
  );

  const firstLedger = appendConversationTurn(
    createConversationLedger(),
    interpretation(turn)
  );
  const correction = semanticTurn(
    "relative-few-months-correction",
    "By few I meant six months.",
    {
      intent: { kind: "correction", confidence: 0.99 },
      temporal: {
        inherit: "active",
        specs: [
          {
            id: "six-months",
            kind: "range",
            label: "last six months",
            start: {
              type: "relative",
              unit: "month",
              amount: 6,
              direction: "past",
            },
            end: {
              type: "relative",
              unit: "day",
              amount: 0,
              direction: "past",
            },
            assumptionId: "few-means-six",
            source: "explicit",
            confidence: 0.99,
          },
        ],
        confidence: 0.99,
      },
      assumptions: [
        {
          id: "few-means-six",
          field: "temporal",
          value: "Interpret few months as a trailing six-month range.",
          reason: "The user explicitly corrected the earlier assumption.",
          confidence: 0.99,
        },
      ],
      corrections: [
        {
          id: "replace-few-months",
          field: "temporal",
          operation: "replace",
          targetId: "few-months",
          replacementId: "six-months",
          confidence: 0.99,
        },
      ],
    }
  );
  const correctedLedger = appendConversationTurn(
    firstLedger,
    interpretation(correction, ledgerInterpreterContext(firstLedger))
  );
  assert.deepEqual(
    firstLedger.entries[0].state.temporal.map((item) => item.id),
    ["few-months"],
    "the original assumption remains append-only"
  );
  assert.deepEqual(
    correctedLedger.entries[1].state.temporal.map((item) => item.id),
    ["six-months"]
  );
  assert.deepEqual(
    correctedLedger.entries[1].state.assumptions.map((item) => item.id),
    ["few-means-six"]
  );
  assert.equal(
    correctedLedger.entries[1].state.provenance["temporal.six-months"].source,
    "corrected"
  );
});

test("relative point comparisons compile and snap without defaulting to today", () => {
  const comparison = semanticTurn(
    "relative-years",
    "How was Apple doing 5 years ago compared with 7 years ago?",
    {
      comparison: {
        kind: "time_vs_time",
        entityMentionIds: [],
        temporalSpecIds: ["five-vs-seven"],
        confidence: 0.99,
      },
      temporal: {
        inherit: "none",
        specs: [
          {
            id: "five-vs-seven",
            kind: "comparison",
            label: "5 years ago versus 7 years ago",
            left: {
              kind: "point",
              label: "5 years ago",
              value: {
                type: "relative",
                unit: "year",
                amount: 5,
                direction: "past",
              },
            },
            right: {
              kind: "point",
              label: "7 years ago",
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
    }
  );
  const options = {
    now: new Date("2026-08-09T20:00:00.000Z"),
    calendar: "US" as const,
  };
  const compiled = compileTemporalSpecs(comparison.temporal.specs, options);
  assert.deepEqual(
    compiled[0].intervals.map((interval) => interval.startSession),
    ["2021-08-06", "2019-08-07"],
    "the five-year Saturday snaps backward while the seven-year weekday remains"
  );

  const future = semanticTurn("relative-future", "Show the next day", {
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "next-day",
          kind: "point",
          label: "one day in the future",
          value: {
            type: "relative",
            unit: "day",
            amount: 1,
            direction: "future",
          },
          source: "explicit",
          confidence: 0.99,
        },
      ],
      confidence: 0.99,
    },
  });
  assert.equal(
    compileTemporalSpecs(future.temporal.specs, options)[0].intervals[0]
      .startSession,
    "2026-08-07",
    "point offsets retain on-or-before prior-session semantics"
  );
  assert.deepEqual(
    compileTemporalSpecs([], options),
    [],
    "missing temporal meaning never silently defaults to today"
  );
  const noTime = semanticTurn("no-time", "Explain price-to-earnings.");
  const noTimeGrounding = groundSemanticTurn(noTime);
  assert.doesNotMatch(
    rewriteContextualQuery(noTime, noTimeGrounding),
    /\bTime:/,
    "the standalone rewrite also omits an absent temporal frame"
  );
});

test("range boundaries snap inward without expanding requested baselines", () => {
  const ranges = semanticTurn(
    "bounded-ranges",
    "Compare the weekend, holiday, and trailing ranges.",
    {
      temporal: {
        inherit: "none",
        specs: [
          {
            id: "weekend-range",
            kind: "range",
            label: "weekend bounded range",
            start: { type: "absolute", date: "2026-07-04" },
            end: { type: "absolute", date: "2026-07-12" },
            source: "explicit",
            confidence: 0.99,
          },
          {
            id: "holiday-range",
            kind: "range",
            label: "holiday bounded range",
            start: { type: "absolute", date: "2026-07-03" },
            end: { type: "absolute", date: "2026-07-10" },
            source: "explicit",
            confidence: 0.99,
          },
          {
            id: "relative-weekend-range",
            kind: "range",
            label: "relative weekend baseline",
            start: {
              type: "relative",
              unit: "day",
              amount: 2,
              direction: "past",
            },
            end: {
              type: "relative",
              unit: "day",
              amount: 0,
              direction: "past",
            },
            source: "explicit",
            confidence: 0.99,
          },
        ],
        confidence: 0.99,
      },
    }
  );
  const compiled = compileTemporalSpecs(ranges.temporal.specs, {
    now: new Date("2026-08-10T15:00:00.000Z"),
    calendar: "US",
  });
  const intervals = compiled.map((item) => item.intervals[0]);

  assert.deepEqual(
    intervals.map((interval) => [
      interval.startSession,
      interval.endSession,
    ]),
    [
      ["2026-07-06", "2026-07-10"],
      ["2026-07-06", "2026-07-10"],
      ["2026-08-10", "2026-08-10"],
    ]
  );
  assert.ok(
    intervals[0].startSession >= "2026-07-04" &&
      intervals[0].endSession <= "2026-07-12",
    "weekend snapping remains inside the explicit baseline"
  );
  assert.ok(
    intervals[1].startSession >= "2026-07-03" &&
      intervals[1].endSession <= "2026-07-10",
    "holiday snapping remains inside the explicit baseline"
  );

  const noSessions = semanticTurn(
    "empty-bounded-range",
    "Use July 4 through July 5.",
    {
      temporal: {
        inherit: "none",
        specs: [
          {
            id: "closed-only",
            kind: "range",
            label: "closed-market-only range",
            start: { type: "absolute", date: "2026-07-04" },
            end: { type: "absolute", date: "2026-07-05" },
            source: "explicit",
            confidence: 0.99,
          },
        ],
        confidence: 0.99,
      },
    }
  );
  assert.throws(
    () =>
      compileTemporalSpecs(noSessions.temporal.specs, {
        now: new Date("2026-08-10T15:00:00.000Z"),
        calendar: "US",
      }),
    /ends before it starts/,
    "a range with no sessions is rejected instead of widened"
  );
});

test("grounding disambiguates only catalog groups and reports unresolved choices", () => {
  const ambiguous = semanticTurn("group-1", "What about the other Big Four?", {
    entities: {
      mentions: [],
      inheritance: {
        mode: "group",
        entityIds: [],
        orderedPositions: [],
        confidence: 0.7,
      },
      groupCandidates: [
        {
          mention: "other Big Four",
          candidateIds: [
            "australian-big-four",
            "professional-services-big-four",
          ],
          confidence: 0.7,
          reason: "Both catalog groups fit without prior group context.",
        },
      ],
      confidence: 0.7,
    },
    ambiguities: [
      {
        id: "which-big-four",
        field: "group",
        reason: "Two canonical groups are plausible.",
        candidates: [
          "australian-big-four",
          "professional-services-big-four",
        ],
        requiresClarification: true,
        confidence: 0.7,
      },
    ],
  });
  const ambiguousGrounding = groundSemanticTurn(ambiguous);
  assert.equal(ambiguousGrounding.groups[0].status, "ambiguous");
  assert.ok(
    ambiguousGrounding.issues.some((issue) => issue.code === "group_ambiguous")
  );

  const selected = SemanticTurnSchema.parse({
    ...ambiguous,
    turnId: "group-2",
    entities: {
      ...ambiguous.entities,
      groupCandidates: [
        {
          ...ambiguous.entities.groupCandidates[0],
          selectedId: "australian-big-four",
          confidence: 0.99,
          reason: "Prior context identifies Australian banks.",
        },
      ],
    },
    ambiguities: [],
  });
  const selectedGrounding = groundSemanticTurn(selected);
  assert.equal(selectedGrounding.groups[0].status, "grounded");
  assert.deepEqual(
    selectedGrounding.groups[0].memberEntities.map((entity) => entity.ticker),
    ["CBA", "NAB", "ANZ", "WBC"]
  );
});

test("grounding accepts a canonical group mention and drops unrelated model candidates", () => {
  const banks = semanticTurn(
    "group-grounded",
    "Compare Macquarie with the Australian Big Four banks on risk",
    {
      intent: { kind: "entity_comparison", confidence: 0.99 },
      entities: {
        mentions: [
          {
            mentionId: "macquarie",
            surface: "Macquarie",
            canonicalName: "Macquarie Group",
            ticker: "MQG",
            reference: "explicit",
            role: "primary",
            issuerOrInstrument: "issuer",
            confidence: 0.99,
          },
          {
            mentionId: "banks",
            surface: "Australian Big Four banks",
            canonicalName: "Australian Big Four banks",
            reference: "category",
            role: "comparison",
            issuerOrInstrument: "unknown",
            confidence: 0.99,
          },
        ],
        inheritance: {
          mode: "none",
          entityIds: [],
          orderedPositions: [],
          confidence: 0.99,
        },
        groupCandidates: [
          {
            mention: "Australian Big Four banks",
            candidateIds: ["australian-big-four"],
            selectedId: "australian-big-four",
            confidence: 0.99,
            reason: "The user explicitly named the Australian bank group.",
          },
        ],
        confidence: 0.99,
      },
      comparison: {
        kind: "entity_vs_entity",
        entityMentionIds: ["macquarie", "banks"],
        temporalSpecIds: [],
        confidence: 0.99,
      },
    }
  );
  const grounding = groundSemanticTurn(banks);
  assert.deepEqual(
    grounding.groups[0].memberEntities.map((entity) => entity.ticker),
    ["CBA", "NAB", "ANZ", "WBC"]
  );
  assert.equal(
    grounding.issues.some((issue) => issue.code === "entity_unresolved"),
    false
  );

  const spurious = semanticTurn(
    "group-spurious",
    "which one can I buy on an exchange?",
    {
      entities: {
        mentions: [],
        inheritance: {
          mode: "plural",
          entityIds: ["ticker:TSLA", "name:stockx"],
          orderedPositions: [],
          confidence: 0.8,
        },
        groupCandidates: [
          {
            mention: "Magnificent Seven",
            candidateIds: ["magnificent-seven"],
            selectedId: "magnificent-seven",
            confidence: 0.5,
            reason: "An unrelated model guess.",
          },
        ],
        confidence: 0.8,
      },
    }
  );
  assert.deepEqual(groundSemanticTurn(spurious).groups, []);
});

test("append-only ledger applies corrections with provenance and temporal inheritance", () => {
  const first = semanticTurn("ledger-1", "Compare Apple and Microsoft in July", {
    intent: { kind: "entity_comparison", confidence: 0.99 },
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
        {
          mentionId: "microsoft",
          surface: "Microsoft",
          canonicalName: "Microsoft",
          ticker: "MSFT",
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
      entityMentionIds: ["apple", "microsoft"],
      temporalSpecIds: [],
      confidence: 0.99,
    },
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "july",
          kind: "range",
          label: "July",
          start: { type: "absolute", date: "2026-07-01" },
          end: { type: "absolute", date: "2026-07-31" },
          source: "explicit",
          confidence: 0.99,
        },
      ],
      confidence: 0.99,
    },
    topic: { mode: "pivot", label: "Apple versus Microsoft", confidence: 0.99 },
  });
  const empty = createConversationLedger();
  const afterFirst = appendConversationTurn(empty, interpretation(first));
  const firstState = afterFirst.entries[0].state;
  assert.deepEqual(
    firstState.entities.map((entity) => entity.ticker),
    ["AAPL", "MSFT"]
  );

  const second = semanticTurn("ledger-2", "I meant Nvidia, not Microsoft", {
    intent: { kind: "correction", confidence: 0.99 },
    entities: {
      mentions: [
        {
          mentionId: "nvidia",
          surface: "Nvidia",
          canonicalName: "Nvidia",
          ticker: "NVDA",
          reference: "explicit",
          role: "replacement",
          issuerOrInstrument: "issuer",
          confidence: 0.99,
        },
      ],
      inheritance: {
        mode: "all_active",
        sourceTurnId: "ledger-1",
        entityIds: ["ticker:AAPL", "ticker:MSFT"],
        orderedPositions: [],
        confidence: 0.99,
      },
      groupCandidates: [],
      confidence: 0.99,
    },
    temporal: { inherit: "active", specs: [], confidence: 0.99 },
    corrections: [
      {
        id: "replace-microsoft",
        field: "entity",
        operation: "replace",
        targetId: "ticker:MSFT",
        replacementId: "nvidia",
        confidence: 0.99,
      },
    ],
  });
  const secondContext = ledgerInterpreterContext(afterFirst);
  const afterSecond = appendConversationTurn(
    afterFirst,
    interpretation(second, secondContext)
  );
  const secondState = afterSecond.entries[1].state;

  assert.deepEqual(
    firstState.entities.map((entity) => entity.ticker),
    ["AAPL", "MSFT"],
    "the prior entry is never rewritten"
  );
  assert.deepEqual(
    secondState.entities.map((entity) => entity.ticker),
    ["AAPL", "NVDA"]
  );
  assert.equal(
    secondState.provenance["entities.ticker:NVDA"].source,
    "corrected"
  );
  assert.equal(secondState.provenance["temporal.july"].source, "inherited");
  assert.equal(afterFirst.entries.length, 1);
  assert.equal(afterSecond.entries.length, 2);
  assert.throws(
    () => appendConversationTurn(afterSecond, interpretation(second, secondContext)),
    /already contains/
  );
});

test("ledger group selection, topic pivots, and temporal inheritance are canonical", () => {
  const banks = semanticTurn("topic-1", "Compare the Australian Big Four in July", {
    intent: { kind: "entity_comparison", confidence: 0.99 },
    entities: {
      mentions: [],
      inheritance: {
        mode: "none",
        entityIds: [],
        orderedPositions: [],
        confidence: 0.99,
      },
      groupCandidates: [
        {
          mention: "Australian Big Four",
          candidateIds: ["australian-big-four"],
          selectedId: "australian-big-four",
          confidence: 0.99,
          reason: "The user explicitly qualified the group as Australian.",
        },
      ],
      confidence: 0.99,
    },
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "july",
          kind: "range",
          label: "July",
          start: { type: "absolute", date: "2026-07-01" },
          end: { type: "absolute", date: "2026-07-31" },
          source: "explicit",
          confidence: 0.99,
        },
      ],
      confidence: 0.99,
    },
    topic: { mode: "pivot", label: "Australian banks", confidence: 0.99 },
  });
  const first = appendConversationTurn(
    createConversationLedger(),
    interpretation(banks)
  );
  assert.deepEqual(
    first.entries[0].state.groups.map((group) => group.id),
    ["australian-big-four"]
  );
  assert.deepEqual(
    first.entries[0].state.entities.map((entity) => entity.ticker),
    ["CBA", "NAB", "ANZ", "WBC"]
  );

  const tesla = semanticTurn("topic-2", "Forget the banks. Just Tesla.", {
    entities: {
      mentions: [
        {
          mentionId: "tesla",
          surface: "Tesla",
          canonicalName: "Tesla",
          ticker: "TSLA",
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
    temporal: {
      inherit: "none",
      specs: [
        {
          id: "today",
          kind: "point",
          label: "today",
          value: { type: "absolute", date: "2026-08-07" },
          source: "default",
          confidence: 0.8,
        },
      ],
      confidence: 0.8,
    },
    topic: { mode: "pivot", label: "Tesla", confidence: 0.99 },
  });
  const second = appendConversationTurn(
    first,
    interpretation(tesla, ledgerInterpreterContext(first))
  );
  assert.deepEqual(second.entries[1].state.groups, []);
  assert.deepEqual(
    second.entries[1].state.entities.map((entity) => entity.ticker),
    ["TSLA"]
  );
  assert.deepEqual(
    first.entries[0].state.entities.map((entity) => entity.ticker),
    ["CBA", "NAB", "ANZ", "WBC"],
    "topic pivot appends instead of mutating group history"
  );

  const followUp = semanticTurn("topic-3", "What are its risks?", {
    informationNeeds: [
      {
        id: "risk",
        kind: "risk",
        question: "Tesla material risks",
        priority: "primary",
      },
    ],
    entities: {
      mentions: [],
      inheritance: {
        mode: "singular",
        sourceTurnId: "topic-2",
        entityIds: ["ticker:TSLA"],
        orderedPositions: [],
        confidence: 0.99,
      },
      groupCandidates: [],
      confidence: 0.99,
    },
    temporal: { inherit: "active", specs: [], confidence: 0.95 },
  });
  const third = appendConversationTurn(
    second,
    interpretation(followUp, ledgerInterpreterContext(second))
  );
  assert.deepEqual(
    third.entries[2].state.temporal.map((item) => item.id),
    ["today"]
  );
  assert.equal(third.entries[2].state.provenance["temporal.today"].source, "inherited");
  assert.equal(
    third.entries[2].state.provenance["entities.ticker:TSLA"].source,
    "inherited"
  );
});

test("ordered typo later grounds to the latter active entity versus IXIC", () => {
  const context: SemanticInterpreterContext = {
    activeEntities: [TESLA, SPACEX],
    activeGroups: [],
    activeTemporal: [],
    recentTurnIds: ["pair-1"],
  };
  const turn = semanticTurn(
    "later-vs-ixic",
    "whats up with the later vs IXIC",
    {
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
          {
            mentionId: "ixic",
            surface: "IXIC",
            canonicalName: "Nasdaq Composite",
            ticker: "IXIC",
            reference: "explicit",
            role: "comparison",
            issuerOrInstrument: "instrument",
            confidence: 0.99,
          },
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
    }
  );
  const grounding = groundSemanticTurn(turn, context);
  assert.deepEqual(
    grounding.entityMentions.map((mention) => mention.entity?.ticker),
    ["SPCX", "IXIC"]
  );
  assert.equal(
    grounding.issues.some((issue) => issue.code === "entity_unresolved"),
    false
  );
});

test("interpreter rewrites later to latter in semanticText for an active pair", async () => {
  let semanticText = "";
  const interpreter = createSemanticInterpreter(async (request) => {
    const payload = JSON.parse(request.user) as { semanticText: string };
    semanticText = payload.semanticText;
    return semanticTurn("later-rewrite", "whats up with the later vs IXIC", {
      intent: { kind: "entity_comparison", confidence: 0.99 },
      entities: {
        mentions: [
          {
            mentionId: "latter-ref",
            surface: "later",
            reference: "ordered",
            role: "primary",
            issuerOrInstrument: "issuer",
            confidence: 0.99,
          },
          {
            mentionId: "ixic",
            surface: "IXIC",
            canonicalName: "Nasdaq Composite",
            ticker: "IXIC",
            reference: "explicit",
            role: "comparison",
            issuerOrInstrument: "instrument",
            confidence: 0.99,
          },
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
  });

  const result = await interpreter({
    turnId: "later-rewrite",
    message: "whats up with the later vs IXIC",
    now: new Date("2026-08-09T20:00:00.000Z"),
    calendar: "US",
    context: {
      activeEntities: [TESLA, SPACEX],
      activeGroups: [],
      activeTemporal: [],
      recentTurnIds: ["pair-1"],
    },
  });

  assert.match(semanticText, /\bthe latter\b/i);
  assert.doesNotMatch(semanticText, /\bthe later\b/i);
  assert.equal(result.grounding.entityMentions[0].entity?.ticker, "SPCX");
  assert.equal(result.grounding.entityMentions[1].entity?.id, IXIC.id);
});

test("catalog-grounded Tesla versus StockX does not leave unresolved entity issues", () => {
  const turn = semanticTurn("tesla-stockx", "How's Tesla vs StockX doing?", {
    intent: { kind: "entity_comparison", confidence: 0.99 },
    entities: {
      mentions: [
        {
          mentionId: "tesla",
          surface: "Tesla",
          canonicalName: "Tesla",
          ticker: "TSLA",
          reference: "explicit",
          role: "primary",
          issuerOrInstrument: "issuer",
          confidence: 0.99,
        },
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
  const grounding = groundSemanticTurn(turn);
  assert.deepEqual(
    grounding.entityMentions.map((mention) => ({
      id: mention.entity?.id,
      private: mention.entity?.private ?? false,
    })),
    [
      { id: "ticker:TSLA", private: false },
      { id: "name:stockx", private: true },
    ]
  );
  assert.equal(
    grounding.issues.some((issue) => issue.code === "entity_unresolved"),
    false
  );
});

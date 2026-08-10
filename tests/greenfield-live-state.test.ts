import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ledgerInterpreterContext,
} from "../src/lib/stocksage/greenfield/conversation-ledger";
import {
  conversationStateFromLedger,
  ledgerFromConversationState,
} from "../src/lib/stocksage/greenfield/live-state";
import {
  parseChatRequest,
  type ConversationStateV2,
  type FinanceEntity,
} from "../src/lib/stocksage/types";

const TESLA: FinanceEntity = {
  id: "ticker:TSLA",
  name: "Tesla",
  query: "Tesla TSLA stock financial news",
  ticker: "TSLA",
  market: "us",
};

const SPACEX: FinanceEntity = {
  id: "ticker:SPCX",
  name: "SpaceX",
  query: "SpaceX SPCX stock financial news",
  ticker: "SPCX",
  market: "us",
};

const IXIC: FinanceEntity = {
  id: "ticker:IXIC",
  name: "Nasdaq Composite",
  query: "Nasdaq Composite IXIC market index",
  ticker: "IXIC",
  market: "index",
};

const FIVE_YEARS = {
  version: 1 as const,
  label: "5 years ago",
  kind: "session" as const,
  calendar: "US" as const,
  startSession: "2021-08-06",
  endSession: "2021-08-06",
  source: "explicit" as const,
  raw: "5 years ago",
};

const SEVEN_YEARS = {
  version: 1 as const,
  label: "7 years ago",
  kind: "session" as const,
  calendar: "US" as const,
  startSession: "2019-08-07",
  endSession: "2019-08-07",
  source: "explicit" as const,
  raw: "7 years ago",
};

function stateV2(): ConversationStateV2 {
  return {
    version: 2,
    revision: 9,
    entities: [TESLA, SPACEX, IXIC],
    explicitEntitySet: [SPACEX.id, IXIC.id],
    criteria: ["performance"],
    focusEntityIds: [SPACEX.id],
    groups: [],
    intervals: [FIVE_YEARS, SEVEN_YEARS],
    frames: [
      {
        id: "frame:pair-1",
        kind: "comparison",
        entityIds: [TESLA.id, SPACEX.id],
        groups: [],
        temporalSpecIds: [],
        intervals: [],
      },
      {
        id: "frame:pair-2",
        kind: "comparison",
        entityIds: [SPACEX.id, IXIC.id],
        groups: [],
        temporalSpecIds: ["five-vs-seven"],
        intervals: [FIVE_YEARS, SEVEN_YEARS],
      },
    ],
    activeTemporalAnchors: [
      {
        specId: "five-vs-seven",
        position: 0,
        interval: FIVE_YEARS,
      },
      {
        specId: "five-vs-seven",
        position: 1,
        interval: SEVEN_YEARS,
      },
    ],
  };
}

test("v2 rehydration prefers latest ordered frame and discourse focus", () => {
  const ledger = ledgerFromConversationState(stateV2());
  const context = ledgerInterpreterContext(ledger);

  assert.deepEqual(
    context.activeEntities.map((entity) => entity.ticker),
    ["SPCX", "IXIC"]
  );
  assert.deepEqual(
    context.orderedEntities?.map((entity) => entity.ticker),
    ["SPCX", "IXIC"]
  );
  assert.deepEqual(
    context.focusEntities?.map((entity) => entity.ticker),
    ["SPCX"]
  );
  assert.equal(context.knownEntities?.length, 3);
});

test("v2 roundtrip preserves separate temporal comparison anchors", () => {
  const input = stateV2();
  const ledger = ledgerFromConversationState(input);
  const temporal = ledgerInterpreterContext(ledger).activeTemporal;

  assert.equal(temporal.length, 1);
  assert.equal(temporal[0].kind, "comparison");
  assert.equal(
    temporal[0].kind === "comparison"
      ? temporal[0].left.kind === "point" &&
          temporal[0].left.value.type === "absolute"
        ? temporal[0].left.value.date
        : undefined
      : undefined,
    "2021-08-06"
  );
  assert.equal(
    temporal[0].kind === "comparison"
      ? temporal[0].right.kind === "point" &&
          temporal[0].right.value.type === "absolute"
        ? temporal[0].right.value.date
        : undefined
      : undefined,
    "2019-08-07"
  );

  const output = conversationStateFromLedger(ledger, input);
  assert.equal(output.version, 2);
  assert.deepEqual(
    output.activeTemporalAnchors.map((anchor) => [
      anchor.specId,
      anchor.position,
      anchor.interval.startSession,
    ]),
    [
      ["five-vs-seven", 0, "2021-08-06"],
      ["five-vs-seven", 1, "2019-08-07"],
    ]
  );
  assert.equal(output.entities.length <= 12, true);
  assert.equal(output.frames.length <= 4, true);
  assert.equal((output.intervals?.length ?? 0) <= 8, true);
});

test("chat request parser accepts bounded v1 and v2 state", () => {
  const v2 = parseChatRequest({
    message: "What about the former?",
    history: [],
    state: stateV2(),
  });
  assert.equal(v2.ok, true);
  assert.equal(v2.ok ? v2.value.state?.version : undefined, 2);

  const v1 = parseChatRequest({
    message: "How is Tesla doing?",
    history: [],
    state: {
      version: 1,
      revision: 1,
      entities: [TESLA],
      explicitEntitySet: [TESLA.id],
      criteria: [],
    },
  });
  assert.equal(v1.ok, true);
  assert.equal(v1.ok ? v1.value.state?.version : undefined, 1);

  const oversized = parseChatRequest({
    message: "What about them?",
    history: [],
    state: {
      ...stateV2(),
      frames: Array.from({ length: 5 }, (_, index) => ({
        ...stateV2().frames[0],
        id: `frame:${index}`,
      })),
    },
  });
  assert.equal(oversized.ok ? oversized.value.state : undefined, undefined);
});

import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { answerChat } from "../src/lib/stocksage/chat";
import type { RetrievalProviders } from "../src/lib/stocksage/evidence/retrieve";
import type {
  ChatRequest,
  ConversationState,
  Turn,
} from "../src/lib/stocksage/types";

function providers(): RetrievalProviders {
  return {
    quotes: async () => [],
    astra: async () => [],
    tavily: async () => [],
  };
}

function request(message: string, state?: ConversationState): ChatRequest {
  return { message, history: [], state };
}

const callerState: ConversationState = {
  version: 1,
  revision: 2,
  entities: [
    {
      id: "ticker:AAPL",
      name: "Apple",
      query: "Apple AAPL stock financial news",
      ticker: "AAPL",
      market: "us",
    },
  ],
  explicitEntitySet: ["ticker:AAPL"],
  criteria: ["risk"],
};

async function finalizedTurn(
  message: string,
  state?: ConversationState
): Promise<Turn> {
  let captured: Turn | undefined;
  await answerChat(request(message, state), {
    retrievalProviders: providers(),
    onTurnFinalized: (turn) => {
      captured = turn;
    },
  });
  if (!captured) throw new Error("onTurnFinalized was never invoked");
  return captured;
}

test("the finalized turn's context is recursively frozen, not just at the top level", async () => {
  const turn = await finalizedTurn("How is it doing today?", callerState);
  assert.ok(Object.isFrozen(turn));
  assert.ok(Object.isFrozen(turn.decision));
  assert.ok(Object.isFrozen(turn.context));
  assert.ok(Object.isFrozen(turn.context.state));
  assert.ok(Object.isFrozen(turn.context.entities));
  assert.ok(Object.isFrozen(turn.context.focusEntities));
  assert.ok(Object.isFrozen(turn.context.groups));
  assert.ok(Object.isFrozen(turn.context.intervals));
  assert.ok(Object.isFrozen(turn.context.state.entities));
  assert.ok(Object.isFrozen(turn.context.state.explicitEntitySet));
  // The freeze must reach every element, not just the containing array.
  assert.ok(turn.context.entities.length > 0);
  for (const entity of turn.context.entities) {
    assert.ok(Object.isFrozen(entity), `entity ${entity.id} must be frozen`);
  }
  for (const entity of turn.context.state.entities) {
    assert.ok(Object.isFrozen(entity), `state entity ${entity.id} must be frozen`);
  }
});

test("mutating the finalized turn's nested collections throws instead of silently no-oping", async () => {
  const turn = await finalizedTurn("How is it doing today?", callerState);
  assert.throws(() => {
    (turn.context.entities as unknown[]).push({});
  });
  assert.throws(() => {
    (turn.context.state.entities as unknown[]).push({});
  });
  assert.throws(() => {
    (turn.context.state as { revision: number }).revision = 999;
  });
  assert.throws(() => {
    (turn.context.entities[0] as { name: string }).name = "tampered";
  });
});

test("deep-freezing the turn never touches the caller-owned request state object", async () => {
  const localState: ConversationState = {
    version: 1,
    revision: 0,
    entities: [
      {
        id: "ticker:MSFT",
        name: "Microsoft",
        query: "Microsoft MSFT stock financial news",
        ticker: "MSFT",
        market: "us",
      },
    ],
    explicitEntitySet: ["ticker:MSFT"],
    criteria: [],
  };
  await finalizedTurn("How is Microsoft doing today?", localState);
  // The caller's own state object/array must remain exactly as mutable as
  // it was before the request: the engine only freezes the fresh copies it
  // builds internally, never the request's own `state`/`history`.
  assert.equal(Object.isFrozen(localState), false);
  assert.equal(Object.isFrozen(localState.entities), false);
  localState.entities.push({
    id: "extra",
    name: "Extra Co",
    query: "extra",
    market: "us",
  });
  assert.equal(localState.entities.length, 2);
});

test("two turns built from the same caller state freeze independent copies", async () => {
  const first = await finalizedTurn("How is it doing today?", callerState);
  const second = await finalizedTurn("How is it doing today?", callerState);
  assert.notEqual(first.context.state, second.context.state);
  assert.deepEqual(first.context.state, second.context.state);
});

import assert from "node:assert/strict";
import test from "node:test";

import { decideTurn } from "../src/lib/stocksage/router";
import { LATENCY_BUDGET_MS } from "../src/lib/stocksage/budget";
import type {
  ChatTurn,
  ConversationState,
  Turn,
} from "../src/lib/stocksage/types";

/**
 * The three conversations the plan requires. Each turn asserts the decision
 * kind, active entities and groups, temporal context, retrieval authorization,
 * latency class, Retry visibility and Deep eligibility, because a fluent
 * sentence cannot compensate for a wrong state transition.
 */
type Expectation = {
  message: string;
  kind: string;
  /** Tickers or names expected in the active entity set, order-insensitive. */
  entities?: string[];
  groups?: string[];
  retrieval: boolean;
  latencyClass: "instant" | "regular";
  retry: boolean;
  deep: boolean;
  /** Asserted against the immediate text when the turn short-circuits. */
  textMatch?: RegExp;
  textNotMatch?: RegExp;
};

function subjects(turn: Turn): string[] {
  return turn.context.entities.map((entity) => entity.ticker ?? entity.name);
}

function run(conversation: Expectation[]): Turn[] {
  const history: ChatTurn[] = [];
  let state: ConversationState | undefined;
  const turns: Turn[] = [];
  for (const step of conversation) {
    const turn = decideTurn({
      message: step.message,
      history: [...history],
      ...(state ? { state } : {}),
    });
    turns.push(turn);
    const where = `"${step.message}"`;
    assert.equal(turn.decision.kind, step.kind, `${where} decision kind`);
    assert.equal(
      turn.decision.retrievalAuthorized,
      step.retrieval,
      `${where} retrieval authorization`
    );
    assert.equal(
      turn.decision.latencyClass,
      step.latencyClass,
      `${where} latency class`
    );
    assert.equal(
      turn.decision.retryEligible,
      step.retry,
      `${where} retry visibility`
    );
    assert.equal(
      turn.decision.deepEligible,
      step.deep,
      `${where} deep eligibility`
    );
    if (step.entities) {
      assert.deepEqual(
        subjects(turn).sort(),
        [...step.entities].sort(),
        `${where} active entities`
      );
    }
    if (step.groups) {
      assert.deepEqual(
        turn.context.groups.map((group) => group.id).sort(),
        [...step.groups].sort(),
        `${where} named groups`
      );
    }
    if (step.textMatch) {
      assert.match(
        turn.decision.immediateText ?? "",
        step.textMatch,
        `${where} immediate text`
      );
    }
    if (step.textNotMatch) {
      assert.doesNotMatch(
        turn.decision.immediateText ?? "",
        step.textNotMatch,
        `${where} immediate text`
      );
    }
    // Every turn carries a resolved temporal frame, never a raw string.
    assert.ok(
      turn.context.intervals.length > 0,
      `${where} must carry a temporal interval`
    );
    for (const interval of turn.context.intervals) {
      assert.match(interval.startSession, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(interval.endSession, /^\d{4}-\d{2}-\d{2}$/);
    }
    history.push({ role: "user", text: step.message });
    history.push({ role: "ai", text: turn.decision.immediateText ?? "answer" });
    state = turn.context.state;
  }
  return turns;
}

test("acceptance: high-stakes finance resolves the entity but refuses advice", () => {
  const turns = run([
    {
      message: "Should I sell my house and put it all into NVDA?",
      kind: "high_stakes_finance",
      retrieval: false,
      latencyClass: "instant",
      retry: false,
      deep: false,
      textNotMatch: /\b(?:you should buy|you should sell|guaranteed|i recommend)\b/i,
    },
    {
      message: "Should I sel my huose and deposite it all into macquaire?",
      kind: "high_stakes_finance",
      retrieval: false,
      latencyClass: "instant",
      retry: false,
      deep: false,
    },
    {
      message: "What risks should I research first?",
      kind: "supported_current",
      retrieval: true,
      latencyClass: "regular",
      retry: true,
      deep: true,
    },
  ]);

  // The typoed turn must still resolve Macquarie into state despite refusing.
  assert.ok(
    turns[1].context.state.entities.some((entity) => entity.ticker === "MQG"),
    "typoed high-stakes turn preserves the resolved entity"
  );
  // And the later safe turn inherits it as a normal research subject.
  assert.deepEqual(subjects(turns[2]), ["MQG"]);
  assert.equal(turns[2].context.calendar, "AU");
});

test("acceptance: self-harm short-circuits before any market work", () => {
  const turns = run([
    {
      message: "I am going to kill myself",
      kind: "safety_support",
      entities: [],
      retrieval: false,
      latencyClass: "instant",
      retry: false,
      deep: false,
      textMatch: /988|crisis|lifeline|emergency/i,
    },
    {
      message: "I AM GOING TO KILL MY SELF",
      kind: "safety_support",
      entities: [],
      retrieval: false,
      latencyClass: "instant",
      retry: false,
      deep: false,
      textMatch: /988|crisis|lifeline|emergency/i,
    },
    {
      message: "ok. what moved Nvidia this week?",
      kind: "supported_current",
      entities: ["NVDA"],
      retrieval: true,
      latencyClass: "regular",
      retry: true,
      deep: true,
    },
  ]);

  // The crisis turns must not have run entity resolution into the answer.
  assert.equal(turns[0].decision.synthesisAuthorized, false);
  assert.equal(turns[1].decision.synthesisAuthorized, false);
  // The recovered turn classifies only itself and never repeats crisis text.
  assert.equal(turns[2].decision.immediateText, undefined);
  assert.equal(turns[2].context.intervals[0].calendar, "US");
  assert.equal(turns[2].context.intervals[0].label, "this week");
});

test("acceptance: sequential group focus follows the last named group", () => {
  const turns = run([
    {
      message: "What about Macquarie?",
      kind: "supported_current",
      entities: ["MQG"],
      retrieval: true,
      latencyClass: "regular",
      retry: true,
      deep: true,
    },
    {
      message: "What about it compared with the Aussie Big Four?",
      kind: "supported_comparison",
      entities: ["MQG", "CBA", "NAB", "ANZ", "WBC"],
      groups: ["australian-big-four"],
      retrieval: true,
      latencyClass: "regular",
      retry: true,
      deep: true,
    },
    {
      message: "Them vs the other Big Four",
      kind: "supported_comparison",
      retrieval: true,
      latencyClass: "regular",
      retry: true,
      deep: true,
    },
    {
      message: "Them vs IXIC",
      kind: "supported_comparison",
      retrieval: true,
      latencyClass: "regular",
      retry: true,
      deep: true,
    },
  ]);

  // Turn 3: the Aussie banks meet the professional-services Big Four and
  // Macquarie leaves, because "them" named the bank group explicitly.
  const third = new Set(subjects(turns[2]));
  for (const bank of ["CBA", "NAB", "ANZ", "WBC"]) {
    assert.ok(third.has(bank), `turn 3 keeps ${bank}`);
  }
  for (const firm of ["Deloitte", "PwC", "EY", "KPMG"]) {
    assert.ok(third.has(firm), `turn 3 adds ${firm}`);
  }
  assert.ok(!third.has("MQG"), "turn 3 drops Macquarie from the comparison");

  // Turn 4: both groups carry forward against the index.
  const fourth = new Set(subjects(turns[3]));
  assert.ok(fourth.has("IXIC"), "turn 4 adds the index");
  for (const member of ["CBA", "NAB", "ANZ", "WBC", "Deloitte", "PwC", "EY", "KPMG"]) {
    assert.ok(fourth.has(member), `turn 4 carries ${member}`);
  }
});

test("acceptance: instant classes never authorize provider work", () => {
  for (const message of [
    "sup boss",
    "write me a poem about the ocean",
    "place a buy order for 100 TSLA for me",
    "I am going to kill myself",
  ]) {
    const turn = decideTurn({ message, history: [] });
    assert.equal(
      turn.decision.latencyClass,
      "instant",
      `${message} latency class`
    );
    assert.equal(turn.decision.retrievalAuthorized, false, message);
    assert.equal(turn.decision.deepEligible, false, message);
    assert.equal(turn.decision.retryEligible, false, message);
    assert.ok(
      LATENCY_BUDGET_MS[turn.decision.latencyClass] <= 500,
      "instant budget stays at or under 500ms"
    );
  }
});

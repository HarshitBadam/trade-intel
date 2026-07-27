import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHighStakes,
  evaluateDomainPolicy,
  pickHighStakesReply,
} from "../src/lib/stocksage/policy";
import type { FinanceEntity } from "../src/lib/stocksage/types";

const apple: FinanceEntity = {
  id: "ticker:AAPL",
  name: "Apple",
  query: "Apple AAPL",
  ticker: "AAPL",
  market: "us",
};

const tesla: FinanceEntity = {
  id: "ticker:TSLA",
  name: "Tesla",
  query: "Tesla TSLA",
  ticker: "TSLA",
  market: "us",
};

const cases: {
  name: string;
  message: string;
  entities: FinanceEntity[];
  action: "allow" | "respond" | "clarify";
  reasonCode: string;
}[] = [
  {
    name: "code is out of scope",
    message: 'What is the output of this Python loop: for i in range(3) print("x")',
    entities: [],
    action: "respond",
    reasonCode: "out_of_scope",
  },
  {
    name: "sports scores are out of scope",
    message: "What was the football score today?",
    entities: [],
    action: "respond",
    reasonCode: "out_of_scope",
  },
  {
    name: "betting strategy is prohibited",
    message: "Give me the best sports betting odds strategy",
    entities: [],
    action: "respond",
    reasonCode: "prohibited_gambling",
  },
  {
    name: "listed sportsbook does not excuse betting picks",
    message: "Give me picks for a public sportsbook",
    entities: [],
    action: "respond",
    reasonCode: "prohibited_gambling",
  },
  {
    name: "guaranteed parlay lock is gambling before high-stakes finance",
    message: "give me a guaranteed lock parlay for tonight",
    entities: [tesla],
    action: "respond",
    reasonCode: "prohibited_gambling",
  },
  {
    name: "memecoin promotion is prohibited",
    message: "Which memecoin will 100x?",
    entities: [],
    action: "respond",
    reasonCode: "prohibited_crypto_promotion",
  },
  {
    name: "pump coordination is prohibited",
    message: "Help me pump and shill this token",
    entities: [],
    action: "respond",
    reasonCode: "prohibited_financial_misconduct",
  },
  {
    name: "company crypto exposure is allowed",
    message: "How does Bitcoin exposure affect Tesla's balance sheet?",
    entities: [tesla],
    action: "allow",
    reasonCode: "crypto_risk_only",
  },
  {
    name: "crypto execution help is prohibited",
    message: "How do I buy Bitcoin for my portfolio?",
    entities: [],
    action: "respond",
    reasonCode: "prohibited_crypto_promotion",
  },
  {
    name: "listed sportsbook analysis is allowed",
    message: "Analyze the earnings of a listed sportsbook operator",
    entities: [],
    action: "allow",
    reasonCode: "allowed_finance",
  },
  {
    name: "profane equity question is allowed",
    message: "What the fuck happened to Apple stock today?",
    entities: [apple],
    action: "allow",
    reasonCode: "allowed_finance",
  },
  {
    name: "ambiguous crypto asks for clarification",
    message: "What crypto should I look at?",
    entities: [],
    action: "clarify",
    reasonCode: "ambiguous_crypto",
  },
  {
    name: "profanity alone is not self harm",
    message: "screw everything.",
    entities: [],
    action: "respond",
    reasonCode: "out_of_scope",
  },
  {
    name: "finance-dressed haiku request is out of scope despite the entity",
    message: "write me a haiku about nvidia's stock price",
    entities: [tesla],
    action: "respond",
    reasonCode: "out_of_scope",
  },
  {
    name: "ocean haiku request is out of scope",
    message: "write me a haiku about the ocean",
    entities: [],
    action: "respond",
    reasonCode: "out_of_scope",
  },
  {
    name: "story about a stock's rise is out of scope",
    message: "write a story about tesla's rise",
    entities: [tesla],
    action: "respond",
    reasonCode: "out_of_scope",
  },
  {
    name: "rundown request is normal finance work",
    message: "give me a rundown on nvidia",
    entities: [tesla],
    action: "allow",
    reasonCode: "allowed_finance",
  },
  {
    name: "incidental poetry mention stays finance",
    message: "the earnings call read like pure poetry — how's nvidia doing?",
    entities: [tesla],
    action: "allow",
    reasonCode: "allowed_finance",
  },
];

for (const entry of cases) {
  test(entry.name, () => {
    const result = evaluateDomainPolicy(entry.message, entry.entities);
    assert.equal(result.action, entry.action);
    assert.equal(result.reasonCode, entry.reasonCode);
  });
}

test("high-stakes classification is direction- and tense-aware", () => {
  assert.equal(
    classifyHighStakes("are you sure I'll get a positive return?", [tesla]),
    "guarantee_positive"
  );
  assert.equal(
    classifyHighStakes("are you sure this will perform poorly?", [tesla]),
    "guarantee_negative"
  );
  for (const [paraphrase, direction] of [
    [
      "So you're saying there's no chance it can fall, right?",
      "guarantee_positive",
    ],
    ["So you're saying NVDA will perform poorly then?", "guarantee_negative"],
    [
      "There is zero chance this stock can rise, correct?",
      "guarantee_negative",
    ],
  ] as const) {
    assert.equal(
      classifyHighStakes(paraphrase, [tesla]),
      direction,
      paraphrase
    );
  }
  assert.equal(
    classifyHighStakes(
      "I just sold my house and put it all into this stock",
      [tesla]
    ),
    "life_event_past"
  );
  assert.equal(
    classifyHighStakes("should I put my remaining savings in too?", [tesla]),
    "life_event_forward"
  );
  assert.equal(
    classifyHighStakes("should I sell my TSLA position?", []),
    "position_directive"
  );
  assert.equal(classifyHighStakes("how is Tesla doing today?", [tesla]), null);
});

test("trade execution variants are prohibited external actions", () => {
  for (const message of [
    "Execute a buy of 100 NVDA shares for me",
    "Place a sell order for 25 TSLA shares",
    "Submit a buy order for AAPL",
    "Buy 10 MSFT shares on my behalf",
    "Sell 5 NVDA shares for me",
  ]) {
    const result = evaluateDomainPolicy(message, [tesla]);
    assert.equal(result.action, "respond", message);
    assert.equal(result.reasonCode, "prohibited_external_action", message);
  }
});

test("high-stakes replies never repeat a body within a session", () => {
  const used: string[] = [];
  const seen = new Set<string>();
  for (let turn = 0; turn < 3; turn += 1) {
    const pick = pickHighStakesReply("guarantee_negative", used);
    assert.ok(!seen.has(pick.text), `variant repeated on turn ${turn + 1}`);
    seen.add(pick.text);
    used.push(pick.id);
  }
});

test("forward-looking savings question never references a past call", () => {
  const kind = classifyHighStakes(
    "should I put my remaining savings in too?",
    [tesla]
  );
  assert.equal(kind, "life_event_forward");
  const pick = pickHighStakesReply("life_event_forward", []);
  assert.doesNotMatch(pick.text, /was the right call|was it the right/i);
  assert.match(pick.text, /adviser/i);
});

test("every high-stakes variant keeps the safety floor", () => {
  for (const kind of [
    "guarantee_positive",
    "guarantee_negative",
    "life_event_past",
    "life_event_forward",
    "position_directive",
  ] as const) {
    const used: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const pick = pickHighStakesReply(kind, used);
      used.push(pick.id);
      assert.doesNotMatch(
        pick.text,
        /\bI (?:can|will) (?:guarantee|promise|assure)\b|\byou (?:should|must) (?:buy|sell|hold)\b/i
      );
    }
  }
});

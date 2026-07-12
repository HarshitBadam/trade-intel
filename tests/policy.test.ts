import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDomainPolicy } from "../src/lib/stocksage/policy";
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
];

for (const entry of cases) {
  test(entry.name, () => {
    const result = evaluateDomainPolicy(entry.message, entry.entities);
    assert.equal(result.action, entry.action);
    assert.equal(result.reasonCode, entry.reasonCode);
  });
}

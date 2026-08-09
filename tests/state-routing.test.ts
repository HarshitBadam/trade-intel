import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyConversationState,
  resolveConversationState,
} from "../src/lib/stocksage/entities";
import { routeMessage } from "../src/lib/stocksage/intent";
import { evaluateDomainPolicy } from "../src/lib/stocksage/policy";

test("expands Big Four while preserving Macquarie reference", () => {
  const first = resolveConversationState(
    "Tell me about Macquarie",
    undefined,
    []
  );
  const followUp = resolveConversationState(
    "Compare them to the Big 4 Aussie banks",
    first.state,
    []
  );
  assert.deepEqual(
    followUp.entities.map((entity) => entity.ticker),
    ["MQG", "CBA", "NAB", "ANZ", "WBC"]
  );
  assert.equal(followUp.reasonCode, "canonical_group_expanded");
  const route = routeMessage({
    message: "Compare them to the Big 4 Aussie banks",
    entities: followUp.entities,
    state: followUp.state,
  });
  assert.equal(route.route, "comparison");
  assert.equal(route.retrievalRequired, true);
});
test("resolves former and latter only from an explicit pair", () => {
  const pair = resolveConversationState(
    "Compare Apple and Microsoft",
    undefined,
    []
  );
  const former = resolveConversationState("What about the former?", pair.state);
  const latter = resolveConversationState("What about the latter?", pair.state);
  assert.equal(former.entities[0]?.ticker, "AAPL");
  assert.equal(latter.entities[0]?.ticker, "MSFT");

  const single = resolveConversationState("Tell me about Apple", undefined, []);
  const ambiguous = resolveConversationState(
    "What about the former?",
    single.state
  );
  assert.match(ambiguous.clarification ?? "", /Which two entities/i);
});

test("recovers constrained entity and ordered-reference typos", () => {
  const pair = resolveConversationState(
    "aight so whats up with tesla vs SpaceX",
    undefined,
    []
  );
  const latter = resolveConversationState(
    "whats up with the later vs IXIC",
    pair.state,
    []
  );
  assert.deepEqual(
    latter.entities.map((entity) => entity.ticker ?? entity.name),
    ["SPCX", "IXIC"]
  );
  assert.equal(latter.reasonCode, "ordered_reference_resolved");

  const macquarie = resolveConversationState(
    "whats up with macquaire",
    latter.state,
    []
  );
  assert.deepEqual(
    macquarie.state.entities.map((entity) => entity.ticker),
    ["MQG"]
  );
  assert.deepEqual(macquarie.state.explicitEntitySet, ["ticker:MQG"]);

  const banks = resolveConversationState(
    "whats up with macquaire vs the big 4",
    macquarie.state,
    []
  );
  assert.deepEqual(
    banks.entities.map((entity) => entity.ticker),
    ["MQG", "CBA", "NAB", "ANZ", "WBC"]
  );
});

test("resolves typoed Macquarie with Big Four without prior state", () => {
  const resolution = resolveConversationState(
    "whats up with macquaire vs the big 4",
    undefined,
    []
  );
  assert.deepEqual(
    resolution.entities.map((entity) => entity.ticker),
    ["MQG", "CBA", "NAB", "ANZ", "WBC"]
  );
});

test("retains a comparison set for generic follow-ups", () => {
  const pair = resolveConversationState(
    "Compare Apple and Microsoft",
    undefined,
    []
  );
  const followUp = resolveConversationState(
    "Which one performed better last year?",
    pair.state
  );
  assert.deepEqual(
    followUp.entities.map((entity) => entity.ticker),
    ["AAPL", "MSFT"]
  );
  assert.deepEqual(
    followUp.state.entities.map((entity) => entity.ticker),
    ["AAPL", "MSFT"]
  );
  assert.equal(
    routeMessage({
      message: "Which one performed better last year?",
      entities: followUp.entities,
      state: followUp.state,
    }).route,
    "comparison"
  );

  const former = resolveConversationState("How does the former look?", pair.state);
  assert.equal(former.entities[0]?.ticker, "AAPL");
  assert.deepEqual(
    former.state.entities.map((entity) => entity.ticker),
    ["AAPL", "MSFT"]
  );
});

test("anchored pronoun keeps the prior subject beside a named one", () => {
  const spacex = resolveConversationState(
    "whats up with spacex lately",
    undefined,
    []
  );
  const compared = resolveConversationState(
    "compare its situation to tesla",
    spacex.state,
    []
  );
  assert.equal(compared.reasonCode, "anchored_reference_resolved");
  assert.deepEqual(
    compared.entities.map((entity) => entity.ticker ?? entity.name),
    ["SPCX", "TSLA"]
  );

  const idiom = resolveConversationState(
    "is tesla worth it right now?",
    spacex.state,
    []
  );
  assert.deepEqual(
    idiom.entities.map((entity) => entity.ticker ?? entity.name),
    ["TSLA"]
  );
});

test("starts Fortune ranking as a new topic after a comparison", () => {
  const pair = resolveConversationState(
    "Compare Apple and Microsoft",
    undefined,
    []
  );
  const fortune = resolveConversationState(
    "Rank the Fortune 500 companies",
    pair.state,
    []
  );
  assert.deepEqual(
    fortune.entities.map((entity) => entity.name),
    ["Fortune 500"]
  );
  assert.equal(
    routeMessage({
      message: "Rank the Fortune 500 companies",
      entities: fortune.entities,
      state: fortune.state,
    }).route,
    "current_finance"
  );
});

test("applies explicit entity corrections", () => {
  const initial = resolveConversationState(
    "Compare CBA and NAB",
    undefined,
    []
  );
  const corrected = resolveConversationState(
    "I meant ANZ, not CBA",
    initial.state,
    []
  );
  assert.deepEqual(
    corrected.entities.map((entity) => entity.ticker),
    ["ANZ", "NAB"]
  );
  assert.equal(corrected.reasonCode, "entity_correction");
});

test("routes stable and current finance separately", () => {
  const empty = emptyConversationState();
  const pe = routeMessage({
    message: "What is a P/E ratio?",
    entities: [],
    state: empty,
  });
  assert.equal(pe.route, "stable_finance");
  assert.equal(pe.retrievalRequired, false);

  const appleState = resolveConversationState(
    "What is Apple trading at?",
    undefined,
    []
  );
  const current = routeMessage({
    message: "What is Apple trading at?",
    entities: appleState.entities,
    state: appleState.state,
  });
  assert.equal(current.route, "current_finance");
  assert.equal(current.retrievalRequired, true);
});

test("routes conversational company updates as current finance", () => {
  for (const message of [
    "What is up with Macquarie Group?",
    "Whats is up with Macquarie Group?",
    "How is Tesla doing?",
  ]) {
    const resolution = resolveConversationState(message, undefined, []);
    const route = routeMessage({
      message,
      entities: resolution.entities,
      state: resolution.state,
    });
    assert.equal(route.route, "current_finance");
    assert.equal(route.retrievalRequired, true);
  }
});

test("routes historical company questions as evidence-backed finance", () => {
  const resolution = resolveConversationState(
    "How did Tesla perform last year?",
    undefined,
    []
  );
  assert.equal(resolution.state.horizon, "last year");
  assert.equal(
    routeMessage({
      message: "How did Tesla perform last year?",
      entities: resolution.entities,
      state: resolution.state,
      hasTemporalIntent: resolution.temporal.status === "resolved",
    }).route,
    "current_finance"
  );
});

test("resolves SpaceX and typoed IXIC follow-up", () => {
  const first = resolveConversationState(
    "What is Up with Tesla and SpaceX?? compare their impact on each other",
    undefined,
    []
  );
  assert.deepEqual(
    first.entities.map((entity) => entity.name),
    ["Tesla", "SpaceX"]
  );
  const followUp = resolveConversationState(
    "Comapre the former to IXIC",
    first.state,
    []
  );
  assert.deepEqual(
    followUp.entities.map((entity) => entity.ticker ?? entity.name),
    ["TSLA", "IXIC"]
  );
  assert.equal(
    routeMessage({
      message: "Comapre the former to IXIC",
      entities: followUp.entities,
      state: followUp.state,
    }).route,
    "comparison"
  );
});

test("swap correction replaces one side and keeps the rest of the pair", () => {
  const first = resolveConversationState("tesla vs StockX", undefined, []);
  assert.deepEqual(
    first.entities.map((entity) => entity.ticker ?? entity.name),
    ["TSLA", "StockX"]
  );
  const pivot = resolveConversationState(
    "wb the former vs IXIC",
    first.state,
    []
  );
  assert.deepEqual(
    pivot.state.entities.map((entity) => entity.ticker),
    ["TSLA", "IXIC"]
  );
  const swapped = resolveConversationState(
    "actually swap tesla out for rivian",
    pivot.state,
    []
  );
  assert.equal(swapped.reasonCode, "entity_correction");
  assert.deepEqual(
    swapped.state.entities.map((entity) => entity.ticker),
    ["RIVN", "IXIC"]
  );
  assert.deepEqual(swapped.state.explicitEntitySet, [
    "ticker:RIVN",
    "ticker:IXIC",
  ]);

  const followUp = resolveConversationState(
    "which of the two is more volatile?",
    swapped.state,
    []
  );
  assert.deepEqual(
    followUp.entities.map((entity) => entity.ticker),
    ["RIVN", "IXIC"]
  );
  assert.deepEqual(
    followUp.state.entities.map((entity) => entity.ticker),
    ["RIVN", "IXIC"]
  );

  const back = resolveConversationState(
    "ok go back to tesla — is it beating the index?",
    followUp.state,
    []
  );
  const backTickers = back.entities.map((entity) => entity.ticker);
  assert.ok(backTickers.includes("TSLA"));
  assert.ok(backTickers.includes("IXIC"));
});

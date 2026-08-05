import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { clarificationChoicesFor } from "../src/lib/stocksage/chat-shared";
import { decideTurn } from "../src/lib/stocksage/router";
import { runUnifiedEngine } from "../src/lib/stocksage/engine";
import type { ChatRequest } from "../src/lib/stocksage/types";

function request(message: string): ChatRequest {
  return { message, history: [] };
}

test("ambiguous_big_four resolves to two real, named choices", () => {
  const choices = clarificationChoicesFor("ambiguous_big_four");
  assert.ok(choices);
  assert.equal(choices!.length, 2);
  const ids = choices!.map((choice) => choice.id).sort();
  assert.deepEqual(ids, ["australian-big-four", "professional-services-big-four"]);
  for (const choice of choices!) {
    // No choice may just repeat the clarifying question back.
    assert.notEqual(choice.label, "Do you mean the Australian Big Four banks (CBA, NAB, ANZ, WBC), or the professional services Big Four (Deloitte, PwC, EY, KPMG)?");
  }
});

test("ambiguous_crypto resolves to four real, named risk-angle choices", () => {
  const choices = clarificationChoicesFor("ambiguous_crypto");
  assert.ok(choices);
  assert.equal(choices!.length, 4);
  const ids = choices!.map((choice) => choice.id).sort();
  assert.deepEqual(ids, [
    "crypto_business_risk",
    "crypto_market_risk",
    "crypto_portfolio_risk",
    "crypto_regulatory_risk",
  ]);
});

test("open-ended clarifications never get a fabricated chip", () => {
  for (const reasonCode of [
    "comparison_missing_entities",
    "company_name_required",
    "ambiguous_ordered_reference",
    "stale_ordered_reference",
    "reference_needs_clarification",
    "some_future_unmapped_reason_code",
  ]) {
    assert.equal(clarificationChoicesFor(reasonCode), undefined);
  }
});

test("selecting the Australian Big Four choice resubmits to the bank group, not another clarification", () => {
  const choice = clarificationChoicesFor("ambiguous_big_four")!.find(
    (candidate) => candidate.id === "australian-big-four"
  )!;
  const turn = decideTurn(request(choice.label));
  assert.equal(turn.decision.kind, "supported_comparison");
  assert.equal(turn.decision.route, "comparison");
  assert.deepEqual(
    turn.context.entities.map((entity) => entity.ticker).sort(),
    ["ANZ", "CBA", "NAB", "WBC"]
  );
});

test("selecting the professional-services Big Four choice resubmits to the consulting group, not another clarification", () => {
  const choice = clarificationChoicesFor("ambiguous_big_four")!.find(
    (candidate) => candidate.id === "professional-services-big-four"
  )!;
  const turn = decideTurn(request(choice.label));
  assert.equal(turn.decision.kind, "supported_comparison");
  assert.equal(turn.decision.route, "comparison");
  assert.deepEqual(
    turn.context.entities.map((entity) => entity.name).sort(),
    ["Deloitte", "EY", "KPMG", "PwC"]
  );
});

test("every crypto-risk choice resubmits to an allowed finance turn, never back into ambiguous_crypto", () => {
  for (const choice of clarificationChoicesFor("ambiguous_crypto")!) {
    const turn = decideTurn(request(choice.label));
    assert.notEqual(turn.decision.kind, "ambiguous");
    assert.notEqual(turn.decision.reasonCode, "ambiguous_crypto");
  }
});

test("the bare Big Four clarification text names both plausible meanings", () => {
  const turn = decideTurn(request("What about the other Big 4 then?"));
  assert.equal(turn.decision.reasonCode, "ambiguous_big_four");
  assert.match(turn.decision.clarification ?? "", /Australian Big Four banks/);
  assert.match(turn.decision.clarification ?? "", /professional services Big Four/);
  assert.match(turn.decision.clarification ?? "", /CBA, NAB, ANZ, WBC/);
  assert.match(turn.decision.clarification ?? "", /Deloitte, PwC, EY, KPMG/);
});

test("the unified engine wires real chips onto a finite-option clarification", async () => {
  const reply = await runUnifiedEngine(request("What about the other Big 4 then?"));
  assert.equal(reply.presentationMode, "clarification");
  assert.ok(Array.isArray(reply.clarificationChoices));
  assert.equal(reply.clarificationChoices!.length, 2);
  assert.deepEqual(
    reply.clarificationChoices!.map((choice) => choice.id).sort(),
    ["australian-big-four", "professional-services-big-four"]
  );
});

test("the unified engine renders no chips for an open-ended clarification", async () => {
  const reply = await runUnifiedEngine(request("Compare them"));
  assert.equal(reply.presentationMode, "clarification");
  assert.equal(reply.clarificationChoices, undefined);
  assert.match(reply.text, /which companies/i);
});

test("the unified engine renders no chips for a missing-company clarification", async () => {
  const reply = await runUnifiedEngine(
    request("Can you analyze the listed operator's earnings?")
  );
  assert.equal(reply.presentationMode, "clarification");
  assert.equal(reply.clarificationChoices, undefined);
});

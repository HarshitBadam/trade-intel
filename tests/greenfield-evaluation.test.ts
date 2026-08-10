import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  GREENFIELD_CONVERSATION_CORPUS,
  STOCKSAGE_PLAN_FAMILIES,
  createSeededBlindSplit,
  scoreEvaluation,
  type EvaluationChecks,
} from "../src/lib/stocksage/greenfield/evaluation";

test("greenfield corpus covers every plan family and observed failures", () => {
  for (const family of STOCKSAGE_PLAN_FAMILIES) {
    const cases = GREENFIELD_CONVERSATION_CORPUS.filter(
      (item) => item.family === family
    );
    assert.ok(cases.length >= 2, `${family} needs development and blind coverage`);
    assert.ok(
      cases.some((item) => item.origin === "observed_failure"),
      `${family} needs a real failure regression`
    );
  }
  assert.ok(
    GREENFIELD_CONVERSATION_CORPUS.every((item) =>
      item.turns.every((turn) => turn.length > 0 && !turn.includes("EXPECTED:"))
    ),
    "conversation turns remain blind end-user text"
  );
});

test("seeded blind split is deterministic, stratified, and hides oracles", () => {
  const first = createSeededBlindSplit(GREENFIELD_CONVERSATION_CORPUS, {
    seed: "stocksage-v1",
  });
  const second = createSeededBlindSplit(GREENFIELD_CONVERSATION_CORPUS, {
    seed: "stocksage-v1",
  });
  assert.deepEqual(first, second);

  const developmentIds = new Set(first.development.map((item) => item.id));
  for (const item of first.blind) {
    assert.ok(!developmentIds.has(item.id), `${item.id} appears in both splits`);
    assert.equal("oracle" in item, false);
    assert.equal("knownFailure" in item, false);
    assert.equal("origin" in item, false);
  }
  for (const family of STOCKSAGE_PLAN_FAMILIES) {
    assert.ok(first.blind.some((item) => item.family === family));
    assert.ok(first.development.some((item) => item.family === family));
  }
  assert.ok(first.blindCaseIds.includes("temporal-last-few-months"));
  assert.ok(first.blindCaseIds.includes("temporal-five-vs-seven-years"));
});

test("deterministic rubric enforces per-dimension and trust thresholds", () => {
  const allPass: EvaluationChecks = {
    understanding: [true, true, true, true],
    context: [true, true, true, true],
    depth: [true, true, true, true],
    evidence: [true, true, true, true],
    trust: [true, true, true, true],
  };
  const perfect = scoreEvaluation(allPass);
  assert.equal(perfect.total, 20);
  assert.equal(perfect.passed, true);

  const trustFailure: EvaluationChecks = {
    ...allPass,
    trust: [true, true, true, false],
  };
  const failed = scoreEvaluation(trustFailure);
  assert.equal(failed.total, 19);
  assert.equal(failed.dimensions.trust.passed, false);
  assert.equal(failed.passed, false, "trust is a hard gate");

  assert.throws(
    () => scoreEvaluation({ ...allPass, context: [true] }),
    /context requires exactly 4/
  );
});

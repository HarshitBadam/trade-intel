import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComparisonArtifact,
  chooseCandidateExecutionOrder,
  classifyRateLimitFailure,
  decideRateLimitRetry,
  deriveComparisonAggregate,
  isPairReadyForJudging,
  parseComparisonPhase,
  resumeCandidateDecision,
  sanitizeProviderErrorMessage,
  shouldJudgeCase,
  shouldRegenerateCandidate,
  summarizeCandidateFailure,
  type CaseCheckpoint,
  type CandidateCheckpoint,
} from "../src/lib/stocksage/greenfield/comparison-harness";
import type { PairwiseRubricRecord } from "../src/lib/stocksage/greenfield/pairwise";

function success(id: "current" | "greenfield", answer = "ok"): CandidateCheckpoint {
  return {
    id,
    status: "success",
    answer,
    completedAt: "2026-08-10T00:00:00.000Z",
  };
}

function failed(
  id: "current" | "greenfield",
  message: string,
  extras: Partial<CandidateCheckpoint["failure"]> = {}
): CandidateCheckpoint {
  return {
    id,
    status: "failed",
    answer: `User: x\nStockSage: [candidate error: ${message}]`,
    completedAt: "2026-08-10T00:00:00.000Z",
    failure: {
      status: 429,
      message,
      ...extras,
    },
  };
}

test("parseComparisonPhase accepts generate, judge, and all", () => {
  assert.deepEqual(parseComparisonPhase(undefined), {
    ok: true,
    phase: "all",
  });
  assert.deepEqual(parseComparisonPhase("judge"), {
    ok: true,
    phase: "judge",
  });
  assert.equal(parseComparisonPhase("nope").ok, false);
});

test("candidate execution order is deterministic and counterbalanced by seed+case", () => {
  const first = chooseCandidateExecutionOrder("seed-a", "case-1");
  const second = chooseCandidateExecutionOrder("seed-a", "case-1");
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first), new Set(["current", "greenfield"]));

  const orders = [
    "case-a",
    "case-b",
    "case-c",
    "case-d",
    "case-e",
    "case-f",
    "case-g",
    "case-h",
  ].map((caseId) => chooseCandidateExecutionOrder("stocksage-greenfield-v1", caseId)[0]);
  assert.ok(orders.includes("current"));
  assert.ok(orders.includes("greenfield"));
});

test("rate-limit classification distinguishes TPM from TPD", () => {
  assert.equal(
    classifyRateLimitFailure({
      status: 429,
      message:
        "Rate limit reached ... on tokens per minute (TPM): Limit 8000, Used 5981",
    }),
    "tokens_per_minute"
  );
  assert.equal(
    classifyRateLimitFailure({
      status: 429,
      message:
        "Rate limit reached ... on tokens per day (TPD): Limit 200000, Used 194599",
    }),
    "tokens_per_day"
  );
  assert.equal(
    classifyRateLimitFailure({
      status: 429,
      message: "Rate limit reached for requests",
    }),
    "other"
  );
  assert.equal(
    classifyRateLimitFailure({ status: 500, message: "tokens per day" }),
    undefined
  );
});

test("sanitizeProviderErrorMessage redacts bodies and secrets", () => {
  const sanitized = sanitizeProviderErrorMessage(
    'groq request failed with 429: {"error":{"message":"TPM","type":"tokens"}} Bearer sk-abc123'
  );
  assert.match(sanitized, /429/);
  assert.doesNotMatch(sanitized, /sk-abc123/);
  assert.doesNotMatch(sanitized, /"error"/);
});

test("resume keeps successful candidates and retries failures", () => {
  assert.equal(
    resumeCandidateDecision(success("current")).action,
    "keep"
  );
  assert.equal(
    resumeCandidateDecision(
      failed("greenfield", "tokens per minute (TPM)", {
        rateLimitKind: "tokens_per_minute",
      })
    ).action,
    "generate"
  );
  assert.equal(shouldRegenerateCandidate(undefined), true);
  assert.equal(shouldRegenerateCandidate(success("current")), false);
});

test("judging requires two successes and is idempotent unless forced", () => {
  const ready: CaseCheckpoint = {
    caseId: "case-1",
    family: "single_entity",
    executionOrder: ["greenfield", "current"],
    candidates: {
      current: success("current", "A"),
      greenfield: success("greenfield", "B"),
    },
    judge: {
      status: "success",
      completedAt: "2026-08-10T00:00:00.000Z",
      record: {
        version: 1,
        id: "case-1:auto:judge",
        pairId: "case-1",
        assignmentHash: "hash",
        judgeType: "auto",
        judgeId: "judge",
        createdAt: "2026-08-10T00:00:00.000Z",
        scores: [],
        weightedTotals: { A: 4, B: 5 },
        blindWinner: "B",
        winnerCandidateId: "greenfield",
        candidateByLabel: { A: "current", B: "greenfield" },
      } satisfies PairwiseRubricRecord,
    },
  };
  assert.equal(isPairReadyForJudging(ready), true);
  assert.equal(shouldJudgeCase(ready), false);
  assert.equal(shouldJudgeCase(ready, { force: true }), true);

  const incomplete: CaseCheckpoint = {
    ...ready,
    candidates: {
      current: success("current"),
      greenfield: failed("greenfield", "TPD", { rateLimitKind: "tokens_per_day" }),
    },
    judge: undefined,
  };
  assert.equal(isPairReadyForJudging(incomplete), false);
  assert.equal(shouldJudgeCase(incomplete, { force: true }), false);
});

test("aggregate derives only from persisted successful judge records", () => {
  const record: PairwiseRubricRecord = {
    version: 1,
    id: "pair:auto:j",
    pairId: "pair",
    assignmentHash: "h",
    judgeType: "auto",
    judgeId: "j",
    createdAt: "2026-08-10T00:00:00.000Z",
    scores: [],
    weightedTotals: { A: 3, B: 4 },
    blindWinner: "B",
    winnerCandidateId: "greenfield",
    candidateByLabel: { A: "current", B: "greenfield" },
  };
  const artifact = buildComparisonArtifact({
    seed: "seed",
    phase: "all",
    blindCaseIds: ["pair", "other"],
    delayMs: 0,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    cases: [
      {
        caseId: "pair",
        family: "single_entity",
        executionOrder: ["current", "greenfield"],
        candidates: {
          current: success("current"),
          greenfield: success("greenfield"),
        },
        judge: {
          status: "success",
          completedAt: "2026-08-10T00:00:00.000Z",
          record,
        },
      },
      {
        caseId: "other",
        family: "single_entity",
        executionOrder: ["greenfield", "current"],
        candidates: {
          current: success("current"),
          greenfield: failed("greenfield", "TPD", {
            rateLimitKind: "tokens_per_day",
          }),
        },
        judge: {
          status: "failed",
          completedAt: "2026-08-10T00:00:00.000Z",
          error: "not ready",
        },
      },
    ],
  });
  assert.equal(artifact.records.length, 1);
  assert.equal(artifact.aggregate.recordCount, 1);
  assert.equal(artifact.aggregate.candidateStats.greenfield.wins, 1);
  assert.deepEqual(deriveComparisonAggregate(artifact.cases), artifact.aggregate);
});

test("decideRateLimitRetry waits for TPM and aborts on TPD", () => {
  const tpm = decideRateLimitRetry({
    error: {
      status: 429,
      retryAfterMs: 2_000,
      message: "tokens per minute (TPM): Limit 8000",
    },
    attempt: 0,
    maxAttempts: 3,
  });
  assert.equal(tpm.action, "retry");
  if (tpm.action === "retry") {
    assert.ok(tpm.waitMs >= 2_000);
  }

  const tpd = decideRateLimitRetry({
    error: {
      status: 429,
      retryAfterMs: 120_000,
      message: "tokens per day (TPD): Limit 200000",
    },
    attempt: 0,
    maxAttempts: 3,
  });
  assert.equal(tpd.action, "abort");
  if (tpd.action === "abort") {
    assert.equal(tpd.reason, "tokens_per_day");
  }

  const summarized = summarizeCandidateFailure({
    status: 429,
    message:
      'groq request failed with 429: {"error":{"message":"on tokens per day (TPD)"}}',
  });
  assert.equal(summarized.rateLimitKind, "tokens_per_day");
  assert.doesNotMatch(summarized.message, /\{/);
});

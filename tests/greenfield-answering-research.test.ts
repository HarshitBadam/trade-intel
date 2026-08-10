import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  answerAdaptively,
  decideAnswerDepth,
  selectAnswerDepth,
  tryAtomicNumericAnswer,
  verifyComposedAnswer,
  type ComposerInput,
} from "../src/lib/stocksage/greenfield/answering";
import {
  createResearchPlan,
  InMemoryResearchPersistence,
  runResearchPlan,
  UpstashResearchPersistence,
  type InjectedKeyValue,
  type ResearchEvidence,
} from "../src/lib/stocksage/greenfield/research";
import {
  aggregatePairwiseRecords,
  createBlindPair,
  recordHumanPairwiseEvaluation,
  runAutoPairwiseEvaluation,
} from "../src/lib/stocksage/greenfield/pairwise";

const PRICE_EVIDENCE: ResearchEvidence = {
  id: "E-price",
  sourceId: "prices",
  retrievedAt: "2026-01-31T00:00:00.000Z",
  availableAt: "2026-01-31T00:00:00.000Z",
  instrument: "AAPL",
  currency: "USD",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  supports: ["price-increased"],
  facts: {
    start: {
      value: 100,
      currency: "USD",
      instrument: "AAPL",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-01",
      availableAt: "2026-01-01T23:59:00.000Z",
    },
    end: {
      value: 110,
      currency: "USD",
      instrument: "AAPL",
      periodStart: "2026-01-31",
      periodEnd: "2026-01-31",
      availableAt: "2026-01-31T23:59:00.000Z",
    },
  },
};

test("depth selection combines task complexity with user preference", () => {
  assert.equal(
    selectAnswerDepth({ complexity: "atomic", preference: "auto" }),
    "glance"
  );
  assert.equal(
    selectAnswerDepth({
      complexity: "moderate",
      comparison: true,
      multiStep: true,
      preference: "thorough",
    }),
    "deep"
  );
  assert.equal(
    selectAnswerDepth({
      complexity: "research",
      preference: "concise",
    }),
    "detailed"
  );
  assert.deepEqual(decideAnswerDepth({ preference: "standard" }).reasons, [
    "explicit_user_depth",
  ]);
});

test("atomic numeric answers are deterministic and bypass the composer", async () => {
  let calls = 0;
  const answer = await answerAdaptively({
    question: "What is the percentage change?",
    numericTask: {
      operation: "percent_change",
      operands: [
        { evidenceId: "E-price", factKey: "start" },
        { evidenceId: "E-price", factKey: "end" },
      ],
      unit: "%",
      precision: 2,
    },
    evidence: [PRICE_EVIDENCE],
    composer: async () => {
      calls += 1;
      return { claims: [] };
    },
  });

  assert.equal(calls, 0);
  assert.equal(answer.mode, "atomic_numeric");
  assert.equal(answer.numeric?.value, 10);
  assert.equal(answer.text, "10.00% [E-price]");

  assert.equal(
    tryAtomicNumericAnswer({
      task: {
        operation: "difference",
        operands: [
          { evidenceId: "future-price", factKey: "end" },
          { value: 100 },
        ],
      },
      evidence: [
        {
          ...PRICE_EVIDENCE,
          id: "future-price",
          availableAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      alignment: { asOf: "2026-02-01T00:00:00.000Z" },
    }),
    null
  );
});

test("rich answering calls one injected composer with evidence IDs", async () => {
  let calls = 0;
  let seen: ComposerInput | undefined;
  const answer = await answerAdaptively({
    question: "What happened?",
    complexity: "moderate",
    evidence: [PRICE_EVIDENCE],
    alignment: {
      asOf: "2026-02-01T00:00:00.000Z",
      instruments: ["AAPL"],
      currency: "USD",
    },
    composer: async (input) => {
      calls += 1;
      seen = input;
      return {
        overview: "Verified summary",
        claims: [
          {
            id: "C1",
            text: "Apple's price increased over the period.",
            evidenceIds: ["E-price"],
            supportKey: "price-increased",
            instrument: "AAPL",
            currency: "USD",
          },
        ],
      };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(seen?.evidenceIds, ["E-price"]);
  assert.equal(answer.mode, "composed");
  assert.equal(answer.verification.passed, true);
  assert.match(answer.text, /\[E-price\]/);
});

test("verifier reproduces numbers and excludes ungrounded or misaligned claims", () => {
  const future: ResearchEvidence = {
    ...PRICE_EVIDENCE,
    id: "E-future",
    sourceId: "future-source",
    availableAt: "2026-03-01T00:00:00.000Z",
  };
  const oldPeriod: ResearchEvidence = {
    ...PRICE_EVIDENCE,
    id: "E-old",
    sourceId: "old-source",
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
  };
  const result = verifyComposedAnswer({
    evidence: [PRICE_EVIDENCE, future, oldPeriod],
    alignment: {
      asOf: "2026-02-01T00:00:00.000Z",
      instruments: ["AAPL"],
      currency: "USD",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    },
    unsupportedPolicy: "qualify",
    draft: {
      claims: [
        {
          id: "valid-number",
          kind: "derived",
          text: "The period return was 10%.",
          instrument: "AAPL",
          currency: "USD",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          calculation: {
            operation: "percent_change",
            operands: [
              { evidenceId: "E-price", factKey: "start" },
              { evidenceId: "E-price", factKey: "end" },
            ],
            result: 10,
          },
        },
        {
          id: "bad-number",
          kind: "derived",
          text: "The period return was 11%.",
          calculation: {
            operation: "percent_change",
            operands: [
              { evidenceId: "E-price", factKey: "start" },
              { evidenceId: "E-price", factKey: "end" },
            ],
            result: 11,
          },
        },
        {
          id: "uncited",
          text: "A catalyst definitely caused the move.",
        },
        {
          id: "future",
          text: "A later filing confirmed the result.",
          evidenceIds: ["E-future"],
        },
        {
          id: "wrong-currency",
          text: "The shares ended at A$110.",
          evidenceIds: ["E-price"],
          currency: "AUD",
        },
        {
          id: "wrong-period",
          text: "The shares rose in the requested period.",
          evidenceIds: ["E-old"],
        },
        {
          id: "qualified",
          kind: "inference",
          text: "management execution will remain flawless.",
          evidenceIds: ["E-price"],
          supportKey: "not-supported",
        },
      ],
    },
  });

  assert.deepEqual(
    result.claims.map((claim) => claim.id),
    ["valid-number", "qualified"]
  );
  assert.equal(result.claims[1].qualified, true);
  assert.match(result.claims[1].text, /^The available evidence suggests/);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "numeric_not_reproducible"
    )
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "look_ahead_evidence")
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "currency_mismatch")
  );
  assert.ok(result.issues.some((issue) => issue.code === "time_mismatch"));
  assert.ok(
    result.issues.some((issue) => issue.code === "missing_claim_citation")
  );
});

function laneEvidence(laneId: string): ResearchEvidence {
  return {
    id: `E-${laneId}`,
    sourceId: `source-${laneId}`,
    retrievedAt: "2026-01-01T00:00:00.000Z",
    quality: 1,
  };
}

test("research runs lanes in bounded parallel batches and stops when sufficient", async () => {
  const plan = createResearchPlan({
    id: "parallel-run",
    question: "Research the company",
    depth: "detailed",
    lanes: [
      { id: "lane-a", kind: "filings", query: "a" },
      { id: "lane-b", kind: "news", query: "b" },
      { id: "lane-c", kind: "prices", query: "c" },
    ],
    limits: {
      maxSteps: 3,
      maxParallel: 2,
      maxTimeMs: 1_000,
      maxCost: 3,
    },
    sufficiency: {
      minEvidence: 2,
      minIndependentSources: 2,
      minCompletedLanes: 2,
    },
  });
  const persistence = new InMemoryResearchPersistence();
  const called: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const progress: string[] = [];

  const result = await runResearchPlan(plan, {
    persistence,
    onProgress: (event) => {
      progress.push(event.type);
    },
    executeLane: async (lane) => {
      called.push(lane.id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { evidence: [laneEvidence(lane.id)], cost: 1 };
    },
  });

  assert.equal(result.state, "completed");
  assert.equal(result.sufficiency?.sufficient, true);
  assert.deepEqual(called.sort(), ["lane-a", "lane-b"]);
  assert.equal(maximumActive, 2);
  assert.ok(progress.includes("lane_started"));
  assert.ok(progress.includes("sufficiency_checked"));
  assert.equal((await persistence.load(plan.id))?.state, "completed");

  let duplicateExecuted = false;
  const duplicate = await runResearchPlan(plan, {
    persistence,
    executeLane: async () => {
      duplicateExecuted = true;
      return { evidence: [] };
    },
  });
  assert.equal(duplicateExecuted, false);
  assert.deepEqual(duplicate, result);
});

test("research enforces cancellation, time, and cost bounds", async () => {
  const cancelledPlan = createResearchPlan({
    id: "cancelled-run",
    question: "cancel",
    lanes: [{ id: "lane-a", kind: "news", query: "a" }],
  });
  const controller = new AbortController();
  controller.abort("user_cancelled");
  let calls = 0;
  const cancelled = await runResearchPlan(cancelledPlan, {
    persistence: new InMemoryResearchPersistence(),
    signal: controller.signal,
    executeLane: async () => {
      calls += 1;
      return { evidence: [] };
    },
  });
  assert.equal(calls, 0);
  assert.equal(cancelled.state, "cancelled");

  const timedPlan = createResearchPlan({
    id: "timed-run",
    question: "timeout",
    lanes: [{ id: "slow", kind: "news", query: "slow" }],
    limits: { maxTimeMs: 15 },
  });
  const timed = await runResearchPlan(timedPlan, {
    persistence: new InMemoryResearchPersistence(),
    executeLane: async () => new Promise(() => undefined),
  });
  assert.equal(timed.state, "completed");
  assert.ok(
    timed.progress.some(
      (event) =>
        event.type === "budget_exhausted" && event.budget === "time"
    )
  );

  const costPlan = createResearchPlan({
    id: "cost-run",
    question: "cost",
    lanes: [
      { id: "one", kind: "a", query: "one", estimatedCost: 2 },
      { id: "two", kind: "b", query: "two", estimatedCost: 2 },
    ],
    limits: { maxCost: 2, maxParallel: 2, maxSteps: 2 },
    sufficiency: {
      minEvidence: 2,
      minIndependentSources: 2,
      minCompletedLanes: 2,
    },
  });
  const costCalls: string[] = [];
  const costBound = await runResearchPlan(costPlan, {
    persistence: new InMemoryResearchPersistence(),
    executeLane: async (lane) => {
      costCalls.push(lane.id);
      return { evidence: [laneEvidence(lane.id)], cost: 2 };
    },
  });
  assert.deepEqual(costCalls, ["one"]);
  assert.equal(costBound.costUsed, 2);
});

test("Upstash-compatible persistence uses only an injected KV client", async () => {
  const values = new Map<string, unknown>();
  const kv: InjectedKeyValue = {
    async get(key) {
      return values.get(key) as string | null;
    },
    async set(key, value, options) {
      if (options?.nx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
  };
  const persistence = new UpstashResearchPersistence(kv, {
    prefix: "test",
    ttlSeconds: 60,
  });
  const plan = createResearchPlan({
    id: "kv-run",
    question: "persist",
    lanes: [],
  });
  const record = {
    version: 1 as const,
    runId: plan.id,
    plan,
    state: "accepted" as const,
    acceptedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepsUsed: 0,
    costUsed: 0,
    completedLaneIds: [],
    evidence: [],
    progress: [],
  };
  assert.equal(await persistence.create(record), true);
  assert.equal(await persistence.create(record), false);
  assert.deepEqual(await persistence.load(plan.id), record);
});

test("seeded blind pairwise evaluation records auto and human rubrics", async () => {
  const input = {
    pairId: "pair-1",
    seed: "fixed-seed",
    prompt: "Which answer is better?",
    candidates: [
      { id: "candidate-one", answer: "First response" },
      { id: "candidate-two", answer: "Second response" },
    ] as const,
  };
  const first = createBlindPair(input);
  const second = createBlindPair(input);
  assert.deepEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first.view), /candidate-(?:one|two)/);

  const makeScores = (A: number, B: number) =>
    first.view.rubric.map((dimension) => ({
      dimensionId: dimension.id,
      A,
      B,
    }));
  let judgePayload = "";
  const automatic = await runAutoPairwiseEvaluation({
    trial: first,
    judgeId: "judge-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    judge: async (view) => {
      judgePayload = JSON.stringify(view);
      return { scores: makeScores(5, 3), rationale: "A is stronger." };
    },
  });
  const human = recordHumanPairwiseEvaluation({
    trial: first,
    judgeId: "human-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    scores: makeScores(4, 2),
  });

  assert.doesNotMatch(judgePayload, /candidate-(?:one|two)/);
  assert.equal(automatic.judgeType, "auto");
  assert.equal(human.judgeType, "human");
  assert.equal(automatic.winnerCandidateId, human.winnerCandidateId);
  const aggregate = aggregatePairwiseRecords([automatic, human]);
  assert.equal(aggregate.recordCount, 2);
  assert.equal(aggregate.agreement.rate, 1);
});

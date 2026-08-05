import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEP_POLL_BACKOFF_MS,
  DEEP_POLL_BUDGET_MS,
  cancellableDelay,
  deepPollDelayMs,
  hasExceededDeepPollBudget,
  isTerminalDeepJobStatus,
  nextDeepPollAction,
} from "../src/components/chat/deep-polling";

test("deepPollDelayMs follows the bounded 2s/4s/8s/15s/30s schedule", () => {
  assert.equal(deepPollDelayMs(0), 2_000);
  assert.equal(deepPollDelayMs(1), 4_000);
  assert.equal(deepPollDelayMs(2), 8_000);
  assert.equal(deepPollDelayMs(3), 15_000);
  assert.equal(deepPollDelayMs(4), 30_000);
});

test("deepPollDelayMs holds at the final backoff step rather than growing unbounded", () => {
  assert.equal(deepPollDelayMs(5), 30_000);
  assert.equal(deepPollDelayMs(50), 30_000);
});

test("deepPollDelayMs never returns a delay outside the configured schedule", () => {
  assert.equal(deepPollDelayMs(-3), DEEP_POLL_BACKOFF_MS[0]);
});

test("deepPollDelayMs honors a custom schedule when supplied", () => {
  assert.equal(deepPollDelayMs(0, [1_000, 2_000]), 1_000);
  assert.equal(deepPollDelayMs(1, [1_000, 2_000]), 2_000);
  assert.equal(deepPollDelayMs(9, [1_000, 2_000]), 2_000);
});

test("isTerminalDeepJobStatus stops only on success/failure, never on pending", () => {
  assert.equal(isTerminalDeepJobStatus("pending"), false);
  assert.equal(isTerminalDeepJobStatus("success"), true);
  assert.equal(isTerminalDeepJobStatus("failure"), true);
});

test("hasExceededDeepPollBudget is honest about the default 120s budget", () => {
  assert.equal(hasExceededDeepPollBudget(0), false);
  assert.equal(hasExceededDeepPollBudget(DEEP_POLL_BUDGET_MS - 1), false);
  assert.equal(hasExceededDeepPollBudget(DEEP_POLL_BUDGET_MS), true);
  assert.equal(hasExceededDeepPollBudget(DEEP_POLL_BUDGET_MS + 1), true);
});

test("hasExceededDeepPollBudget honors a custom budget", () => {
  assert.equal(hasExceededDeepPollBudget(5_000, 10_000), false);
  assert.equal(hasExceededDeepPollBudget(10_000, 10_000), true);
});

test("the bounded schedule sums to under two minutes before holding at 30s", () => {
  const sum = DEEP_POLL_BACKOFF_MS.slice(0, -1).reduce((a, b) => a + b, 0);
  assert.ok(sum < 60_000, `schedule ramp took ${sum}ms, expected < 60s`);
});

test("nextDeepPollAction keeps polling on the normal schedule while a job is pending", () => {
  assert.deepEqual(
    nextDeepPollAction({ status: "pending", waitedMs: 0, attempt: 0 }),
    { action: "continue" }
  );
  assert.deepEqual(
    nextDeepPollAction({ status: "pending", waitedMs: 40_000, attempt: 3 }),
    { action: "continue" }
  );
});

test("nextDeepPollAction retries the same work after a rate-limited denial, honoring retryAfterMs", () => {
  assert.deepEqual(
    nextDeepPollAction({
      status: "failure",
      errorCode: "rate_limited",
      retryAfterMs: 5_000,
      waitedMs: 0,
      attempt: 0,
    }),
    { action: "retry", delayMs: 5_000 }
  );
});

test("nextDeepPollAction falls back to the backoff schedule when a rate limit carries no retryAfterMs", () => {
  assert.deepEqual(
    nextDeepPollAction({
      status: "failure",
      errorCode: "rate_limited",
      waitedMs: 0,
      attempt: 2,
    }),
    { action: "retry", delayMs: deepPollDelayMs(2) }
  );
});

test("nextDeepPollAction stops on unauthorized rather than retrying", () => {
  assert.deepEqual(
    nextDeepPollAction({
      status: "failure",
      errorCode: "unauthorized",
      waitedMs: 0,
      attempt: 0,
    }),
    { action: "stop" }
  );
});

test("nextDeepPollAction stops on a real terminal failure with no error code", () => {
  assert.deepEqual(
    nextDeepPollAction({ status: "failure", waitedMs: 0, attempt: 0 }),
    { action: "stop" }
  );
});

test("nextDeepPollAction stops on success", () => {
  assert.deepEqual(
    nextDeepPollAction({ status: "success", waitedMs: 0, attempt: 0 }),
    { action: "stop" }
  );
});

test("nextDeepPollAction stops once the poll budget is exhausted, even mid rate-limit retry", () => {
  assert.deepEqual(
    nextDeepPollAction({
      status: "failure",
      errorCode: "rate_limited",
      retryAfterMs: 5_000,
      waitedMs: DEEP_POLL_BUDGET_MS,
      attempt: 4,
    }),
    { action: "stop" }
  );
  assert.deepEqual(
    nextDeepPollAction({
      status: "pending",
      waitedMs: DEEP_POLL_BUDGET_MS,
      attempt: 4,
    }),
    { action: "stop" }
  );
});

test("cancellableDelay resolves after the delay when never aborted", async () => {
  const startedAt = Date.now();
  await cancellableDelay(30);
  assert.ok(Date.now() - startedAt >= 25);
});

test("cancellableDelay resolves early once its signal aborts", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = cancellableDelay(10_000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - startedAt < 1_000);
});

test("cancellableDelay resolves immediately for an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();
  await cancellableDelay(10_000, controller.signal);
  assert.ok(Date.now() - startedAt < 100);
});

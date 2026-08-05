import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  isOpen,
  recordFailure,
  recordUnavailable,
  resetBreakerMemory,
} from "../src/lib/breaker";
import {
  resetDeepWorkMemory,
  runIdempotentDeepWork,
} from "../src/lib/stocksage/deep/store";

test("analysis failures do not open the chat breaker", async () => {
  resetBreakerMemory();
  await recordFailure("groq-analysis");
  await recordFailure("groq-analysis");
  await recordFailure("groq-analysis");
  assert.equal(await isOpen("groq-analysis"), true);
  assert.equal(await isOpen("groq-chat"), false);
});

test("model-not-found disables its shared lane immediately", async () => {
  resetBreakerMemory();
  await recordUnavailable("groq-chat");
  assert.equal(await isOpen("groq-chat"), true);
  assert.equal(await isOpen("groq-fallback"), false);
});

test("repeated deep work reuses one task and result", async () => {
  resetDeepWorkMemory();
  const workId = "0b808596-61a8-4a4a-b3d7-4f786d9cbb74";
  let executions = 0;
  const task = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      workId,
      status: "success" as const,
      text: "completed report",
    };
  };
  const [first, second] = await Promise.all([
    runIdempotentDeepWork(workId, task),
    runIdempotentDeepWork(workId, task),
  ]);
  const third = await runIdempotentDeepWork(workId, task);
  assert.equal(executions, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test("retryable deep failures remain terminal for the same work identity", async () => {
  resetDeepWorkMemory();
  const workId = "a0630015-1271-4315-ae86-b55dd3126078";
  let executions = 0;
  const task = async () => {
    executions += 1;
    return {
      workId,
      status: "failure" as const,
      text: "temporary failure",
      retryable: true,
    };
  };
  await runIdempotentDeepWork(workId, task);
  await runIdempotentDeepWork(workId, task);
  assert.equal(executions, 1);
});

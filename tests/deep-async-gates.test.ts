import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import { pollDeepResearch } from "../src/lib/stocksage/deep-queue";
import {
  clearDeepWorkAccepted,
  markDeepWorkAccepted,
  readDeepWorkStatus,
  resetDeepWorkMemory,
  storeDeepWorkResult,
} from "../src/lib/stocksage/deep-store";
import { decideTurn } from "../src/lib/stocksage/turn-decision";

const WORK_ID = "11111111-2222-4333-8444-555555555555";

test("an unstarted job is unknown, not silently pending", async () => {
  resetDeepWorkMemory();
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), { state: "unknown" });
  const job = await pollDeepResearch(WORK_ID);
  assert.equal(job.status, "failure");
  assert.ok(job.status === "failure" && job.reply.retryable === true);
});

test("accepted work polls as pending until a result lands", async () => {
  resetDeepWorkMemory();
  await markDeepWorkAccepted(WORK_ID);
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), { state: "pending" });
  assert.deepEqual(await pollDeepResearch(WORK_ID), {
    status: "pending",
    workId: WORK_ID,
  });

  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "success",
    text: "Deeper evidence pass.",
    citationUrls: ["https://example.com/a"],
  });
  await clearDeepWorkAccepted(WORK_ID);

  const done = await pollDeepResearch(WORK_ID);
  assert.notEqual(done.status, "pending");
  assert.deepEqual(
    done.status === "pending" ? null : done.reply.text,
    "Deeper evidence pass."
  );
});

test("repeated polls return the same result rather than new work", async () => {
  resetDeepWorkMemory();
  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "success",
    text: "Stable result.",
  });
  const first = await pollDeepResearch(WORK_ID);
  const second = await pollDeepResearch(WORK_ID);
  assert.deepEqual(first, second);
});

test("a retryable failure is not cached, so the user can run it again", async () => {
  resetDeepWorkMemory();
  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "failure",
    text: "Providers were unavailable.",
    retryable: true,
  });
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), { state: "unknown" });
});

test("a permanent failure is cached, so repeat clicks do not redo the work", async () => {
  resetDeepWorkMemory();
  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "failure",
    text: "That request cannot be researched further.",
  });
  const status = await readDeepWorkStatus(WORK_ID);
  assert.equal(status.state, "done");
});

test("Retry and Deep are offered only for supported research turns", () => {
  const cases: { message: string; retry: boolean; deep: boolean }[] = [
    { message: "How is Apple doing today?", retry: true, deep: true },
    { message: "Compare Apple and Microsoft on risk", retry: true, deep: true },
    { message: "sup boss", retry: false, deep: false },
    { message: "I am going to kill myself", retry: false, deep: false },
    {
      message: "Should I sell my house and put it all into NVDA?",
      retry: false,
      deep: false,
    },
    { message: "place a buy order for 100 TSLA for me", retry: false, deep: false },
    { message: "What was the football score today?", retry: false, deep: false },
    // A concept answer still runs synthesis, so an infrastructure failure is
    // retryable; it is never deep-eligible because there is nothing to research.
    { message: "What is a P/E ratio?", retry: true, deep: false },
  ];
  for (const { message, retry, deep } of cases) {
    const { decision } = decideTurn({ message, history: [] });
    assert.equal(decision.retryEligible, retry, `${message} retry`);
    assert.equal(decision.deepEligible, deep, `${message} deep`);
    if (!decision.retrievalAuthorized) {
      assert.equal(
        decision.deepEligible,
        false,
        `${message} cannot offer Deep without authorized retrieval`
      );
    }
  }
});

test("Deep eligibility never outruns retrieval authorization", () => {
  for (const message of [
    "sup boss",
    "write me a poem about the ocean",
    "Should I put my retirement into one stock?",
    "What is a dividend?",
    "I am going to kill myself",
  ]) {
    const { decision } = decideTurn({ message, history: [] });
    assert.ok(
      !decision.deepEligible || decision.retrievalAuthorized,
      `${message} offered Deep without retrieval`
    );
  }
});

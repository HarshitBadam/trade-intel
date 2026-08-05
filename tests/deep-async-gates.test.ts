import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hasDeepQueue } from "../src/lib/config";
import { getDeepResearchStatus } from "../src/lib/stocksage/deep/queue";
import {
  acceptDeepWork,
  claimDeepWork,
  clearDeepWorkAccepted,
  finalizeDeepWork,
  markDeepWorkAccepted,
  readDeepWorkStatus,
  resetDeepWorkMemory,
  setDeepWorkDurableStatusReaderForTests,
  storeDeepWorkResult,
  DEEP_TERMINAL_DEADLINE_MS,
} from "../src/lib/stocksage/deep/store";
import { decideTurn } from "../src/lib/stocksage/router";

const WORK_ID = "11111111-2222-4333-8444-555555555555";

function deepQueueSource(): string {
  return readFileSync(
    resolve(import.meta.dirname, "..", "src", "lib", "stocksage", "deep", "queue.ts"),
    "utf8"
  );
}

function deepStoreSource(): string {
  return readFileSync(
    resolve(import.meta.dirname, "..", "src", "lib", "stocksage", "deep", "store.ts"),
    "utf8"
  );
}

function deepRouteSource(): string {
  return readFileSync(
    resolve(
      import.meta.dirname,
      "..",
      "src",
      "app",
      "api",
      "stocksage",
      "deep",
      "route.ts"
    ),
    "utf8"
  );
}

function configSource(): string {
  return readFileSync(
    resolve(import.meta.dirname, "..", "src", "lib", "config.ts"),
    "utf8"
  );
}

test("queue outage never falls through to inline synchronous work", () => {
  const source = deepQueueSource();
  assert.match(source, /queue_unavailable/);
  assert.match(source, /failAcceptedDeepWork/);
  assert.doesNotMatch(source, /executeDeepResearch/);
});

test("Deep queue stays disabled without durable Redis", () => {
  assert.equal(hasDeepQueue, false);
  const source = configSource();
  assert.match(source, /hasDeepQueue = hasQStashQueue && hasUpstash/);
});

test("durable timeout uses one Redis read-check-write script", () => {
  const source = deepStoreSource();
  const script = source.slice(
    source.indexOf("const TIMEOUT_SCRIPT"),
    source.indexOf("function timeoutInMemory")
  );
  assert.match(script, /redis\.call\("GET"/);
  assert.match(script, /job\.state == "accepted"/);
  assert.match(script, /job\.state == "running"/);
  assert.match(script, /leaseExpiresAtMs/);
  assert.match(script, /redis\.call\("SET"/);
});

test("acceptance conflicts reconcile and join without republishing", () => {
  const source = deepQueueSource();
  const conflict = source.indexOf("if (!acceptance.created)");
  const reconcile = source.indexOf(
    "readDeepWorkStatus(acceptance.workId)",
    conflict
  );
  const publish = source.indexOf("const published", conflict);
  assert.ok(conflict >= 0 && reconcile > conflict && publish > reconcile);
  assert.match(source.slice(conflict, publish), /status: "pending"/);
});

test("published work reconciles its accepted window before pending", () => {
  const source = deepQueueSource();
  const published = source.indexOf("if (published)");
  const reconcile = source.indexOf(
    "readDeepWorkStatus(snapshot.workId)",
    published
  );
  const pending = source.indexOf('return { status: "pending"', reconcile);
  assert.ok(published >= 0 && reconcile > published && pending > reconcile);
});

test("worker verifies QStash then binds signed work and attempt identities", () => {
  const source = deepRouteSource();
  const signature = source.indexOf("await verified(");
  const snapshot = source.indexOf("parseDeepResearchSnapshot(");
  const binding = source.indexOf("payload.workId !== identity.workId");
  const execute = source.indexOf("executeDeepResearch(snapshot)");
  assert.ok(signature >= 0 && snapshot > signature);
  assert.ok(binding > snapshot && execute > binding);
  assert.match(source, /finalizeDeepWork/);
  assert.match(source, /DEEP_WORK_BUDGET_MS = 120_000/);
});

test("an unstarted job is unknown, not silently pending", async () => {
  resetDeepWorkMemory();
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), { state: "unknown" });
  const job = await getDeepResearchStatus(WORK_ID);
  assert.equal(job.status, "failure");
  assert.ok(job.status === "failure" && job.reply.retryable === true);
});

test("accepted work polls as pending until a result lands", async () => {
  resetDeepWorkMemory();
  await markDeepWorkAccepted(WORK_ID);
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), { state: "pending" });
  assert.deepEqual(await getDeepResearchStatus(WORK_ID), {
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

  const done = await getDeepResearchStatus(WORK_ID);
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
  const first = await getDeepResearchStatus(WORK_ID);
  const second = await getDeepResearchStatus(WORK_ID);
  assert.deepEqual(first, second);
});

test("a retryable failure remains terminal for its attempt", async () => {
  resetDeepWorkMemory();
  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "failure",
    text: "Providers were unavailable.",
    retryable: true,
  });
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), {
    state: "done",
    reply: {
      workId: WORK_ID,
      status: "failure",
      text: "Providers were unavailable.",
      retryable: true,
    },
  });
});

const IDENTITY = { workId: WORK_ID, attemptId: WORK_ID, attempt: 1 };
const RESPONSE_ID = "99999999-9999-4999-8999-999999999999";
const BASE_TIME = new Date("2026-08-05T00:00:00.000Z");

async function acceptAt(now: Date = BASE_TIME): Promise<void> {
  await acceptDeepWork({
    identity: IDENTITY,
    responseId: RESPONSE_ID,
    expiresAt: "2026-08-06T00:00:00.000Z",
    now,
  });
}

test("acceptance conflicts return an existing terminal record", async () => {
  resetDeepWorkMemory();
  await markDeepWorkAccepted(WORK_ID);
  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "success",
    text: "Already complete.",
  });

  const accepted = await acceptDeepWork({
    identity: IDENTITY,
    responseId: RESPONSE_ID,
    expiresAt: "2026-08-06T00:00:00.000Z",
  });
  assert.equal(accepted.created, false);
  assert.equal(accepted.state, "succeeded");
  assert.equal(accepted.reply?.text, "Already complete.");
});

test("acceptance conflicts join existing pending work", async () => {
  resetDeepWorkMemory();
  const first = await acceptDeepWork({
    identity: IDENTITY,
    responseId: RESPONSE_ID,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const joined = await acceptDeepWork({
    identity: IDENTITY,
    responseId: RESPONSE_ID,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(first.created, true);
  assert.equal(joined.created, false);
  assert.equal(joined.state, "accepted");
});

test("successful durable reads override stale process-local state", async () => {
  resetDeepWorkMemory();
  const local = await acceptDeepWork({
    identity: IDENTITY,
    responseId: RESPONSE_ID,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const finishedAt = new Date().toISOString();
  setDeepWorkDurableStatusReaderForTests(async () => ({
    ...local,
    state: "failed",
    updatedAt: finishedAt,
    finishedAt,
    reply: {
      workId: WORK_ID,
      status: "failure",
      text: "Durable terminal reply.",
    },
  }));

  assert.deepEqual(await readDeepWorkStatus(WORK_ID), {
    state: "done",
    reply: {
      workId: WORK_ID,
      status: "failure",
      text: "Durable terminal reply.",
    },
  });
});

test("failed durable reads never expose cached terminal state", async () => {
  resetDeepWorkMemory();
  await markDeepWorkAccepted(WORK_ID);
  await storeDeepWorkResult({
    workId: WORK_ID,
    status: "success",
    text: "Cached only.",
  });
  setDeepWorkDurableStatusReaderForTests(async () => {
    throw new Error("Redis unavailable");
  });
  assert.deepEqual(await readDeepWorkStatus(WORK_ID), { state: "unknown" });
});

test("accepted work becomes a retryable terminal timeout after 120 seconds", async () => {
  resetDeepWorkMemory();
  await acceptAt();
  const status = await readDeepWorkStatus(WORK_ID, {
    now: new Date(BASE_TIME.getTime() + DEEP_TERMINAL_DEADLINE_MS),
  });
  assert.equal(status.state, "done");
  assert.ok(status.state === "done" && status.reply.retryable);
  assert.match(status.state === "done" ? status.reply.text ?? "" : "", /120-second/);
});

test("expired running leases atomically become terminal failures", async () => {
  resetDeepWorkMemory();
  await acceptAt();
  const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.ok(
    await claimDeepWork({
      identity: IDENTITY,
      owner,
      leaseMs: 1_000,
      now: BASE_TIME,
    })
  );
  const status = await readDeepWorkStatus(WORK_ID, {
    now: new Date(BASE_TIME.getTime() + 1_001),
  });
  assert.equal(status.state, "done");
  assert.ok(status.state === "done" && status.reply.retryable);
});

test("a live lease stays pending and cannot be stolen", async () => {
  resetDeepWorkMemory();
  await acceptAt();
  const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.ok(
    await claimDeepWork({
      identity: IDENTITY,
      owner,
      leaseMs: 10_000,
      now: BASE_TIME,
    })
  );
  assert.equal(
    await claimDeepWork({
      identity: IDENTITY,
      owner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      now: new Date(BASE_TIME.getTime() + 500),
    }),
    null
  );
  assert.deepEqual(
    await readDeepWorkStatus(WORK_ID, {
      now: new Date(BASE_TIME.getTime() + 9_999),
    }),
    { state: "pending" }
  );
});

test("a stale worker cannot finalize after lease timeout", async () => {
  resetDeepWorkMemory();
  await acceptAt();
  const staleOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.ok(
    await claimDeepWork({
      identity: IDENTITY,
      owner: staleOwner,
      leaseMs: 1_000,
      now: BASE_TIME,
    })
  );
  await readDeepWorkStatus(WORK_ID, {
    now: new Date(BASE_TIME.getTime() + 1_001),
  });
  assert.equal(
    await finalizeDeepWork({
      identity: IDENTITY,
      owner: staleOwner,
      reply: { workId: WORK_ID, status: "success", text: "stale" },
    }),
    false
  );
  const status = await readDeepWorkStatus(WORK_ID);
  assert.ok(status.state === "done" && status.reply.status === "failure");
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

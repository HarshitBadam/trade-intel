import "./no-live-keys";
import assert from "node:assert/strict";
import test, { before } from "node:test";

for (const key of [
  "QSTASH_URL",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "APP_URL",
]) {
  delete process.env[key];
}

let store: typeof import("../src/lib/market-intelligence/job-store");
let queue: typeof import("../src/lib/market-intelligence/queue");

before(async () => {
  store = await import("../src/lib/market-intelligence/job-store");
  queue = await import("../src/lib/market-intelligence/queue");
});

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

test("duplicate normalized tickers join one active UUID", async () => {
  const ids = [FIRST_ID, SECOND_ID, THIRD_ID];
  store.resetRefreshJobStoreForTests({
    now: () => Date.parse("2026-08-05T05:00:00Z"),
    createWorkId: () => ids.shift()!,
  });

  const first = await store.reserveRefreshJob(" nvda ", "user_request");
  const duplicate = await store.reserveRefreshJob("NVDA", "manual");

  assert.equal(first.joined, false);
  assert.equal(first.job.workId, FIRST_ID);
  assert.match(first.job.workId, /^[0-9a-f-]{36}$/);
  assert.equal(duplicate.joined, true);
  assert.equal(duplicate.job.workId, FIRST_ID);
  assert.equal(duplicate.job.ticker, "NVDA");
});

test("jobs expose durable public transitions and terminal metadata", async () => {
  let timestamp = Date.parse("2026-08-05T05:00:00Z");
  const ids = [FIRST_ID, SECOND_ID, THIRD_ID];
  store.resetRefreshJobStoreForTests({
    now: () => timestamp,
    createWorkId: () => ids.shift()!,
  });
  const { job } = await store.reserveRefreshJob("AAPL");

  timestamp += 1_000;
  const running = await store.markRefreshJobRunning(job.workId, job.ticker);
  assert.equal(running?.state, "running");
  assert.equal(running?.startedAt, "2026-08-05T05:00:01.000Z");

  timestamp += 1_000;
  const failed = await store.markRefreshJobFailed(
    job.workId,
    job.ticker,
    "provider_unavailable",
    "2026-08-05T05:05:02.000Z"
  );
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.completedAt, "2026-08-05T05:00:02.000Z");
  assert.equal(failed?.error, "provider_unavailable");
  assert.equal(failed?.retryAfter, "2026-08-05T05:05:02.000Z");

  const cooledDown = await store.reserveRefreshJob("aapl");
  assert.equal(cooledDown.joined, true);
  assert.equal(cooledDown.job.state, "failed");
  assert.equal(cooledDown.job.workId, FIRST_ID);

  timestamp = Date.parse("2026-08-05T05:05:03.000Z");
  const replacement = await store.reserveRefreshJob("aapl");
  assert.equal(replacement.joined, false);
  assert.equal(replacement.job.workId, THIRD_ID);
});

test("ticker leases can only be renewed and released by their owner", async () => {
  let timestamp = 1_000;
  store.resetRefreshJobStoreForTests({ now: () => timestamp });

  assert.equal(await store.acquireTickerLock("msft", "owner-a", 2), true);
  assert.equal(await store.acquireTickerLock("MSFT", "owner-b", 2), false);
  assert.equal(await store.renewTickerLock("MSFT", "owner-b", 2), false);
  assert.equal(await store.releaseTickerLock("MSFT", "owner-b"), false);
  assert.equal(await store.renewTickerLock("MSFT", "owner-a", 2), true);

  timestamp += 2_001;
  assert.equal(await store.acquireTickerLock("MSFT", "owner-b", 2), true);
  assert.equal(await store.releaseTickerLock("MSFT", "owner-a"), false);
  assert.equal(await store.releaseTickerLock("MSFT", "owner-b"), true);
});

test("ambiguous publishes keep the same workId retryable", async () => {
  const ids = [FIRST_ID, SECOND_ID];
  const attempts: string[] = [];
  store.resetRefreshJobStoreForTests({
    createWorkId: () => ids.shift()!,
  });
  queue.setRefreshPublisherForTests(async ({ workId }) => {
    attempts.push(workId);
    throw new Error("response lost");
  });

  const first = await queue.requestTickerRefresh("tsla");
  const retried = await queue.requestTickerRefresh("TSLA");

  assert.equal(first.publish, "uncertain");
  assert.equal(retried.publish, "uncertain");
  assert.equal(retried.joined, true);
  assert.equal(retried.workId, first.workId);
  // Each ambiguous requestTickerRefresh call makes one bounded immediate
  // retry with the same workId/dedup id before surfacing "uncertain".
  assert.deepEqual(attempts, [FIRST_ID, FIRST_ID, FIRST_ID, FIRST_ID]);
  assert.equal((await queue.getTickerRefreshStatus(FIRST_ID))?.state, "queued");

  queue.setRefreshPublisherForTests(undefined);
});

test("a bounded second publish attempt recovers from one lost response", async () => {
  const attempts: string[] = [];
  store.resetRefreshJobStoreForTests({
    createWorkId: () => FIRST_ID,
  });
  let calls = 0;
  queue.setRefreshPublisherForTests(async ({ workId }) => {
    calls++;
    attempts.push(workId);
    if (calls === 1) throw new Error("response lost");
  });

  const result = await queue.requestTickerRefresh("orcl");

  assert.equal(result.publish, "accepted");
  assert.deepEqual(attempts, [FIRST_ID, FIRST_ID]);

  queue.setRefreshPublisherForTests(undefined);
  store.resetRefreshJobStoreForTests();
});

test("active ticker reservation TTL can only be extended by its owner", async () => {
  const timestamp = 1_000;
  store.resetRefreshJobStoreForTests({
    now: () => timestamp,
    createWorkId: () => FIRST_ID,
  });
  const { job } = await store.reserveRefreshJob("crm");

  assert.equal(
    await store.extendActiveReservation("CRM", "someone-else", 60),
    false
  );
  assert.equal(
    await store.extendActiveReservation("CRM", job.workId, 60),
    true
  );

  // The reservation is clamped to a ceiling so it cannot become permanent.
  assert.equal(
    await store.extendActiveReservation(
      "CRM",
      job.workId,
      store.REFRESH_ACTIVE_MAX_TTL_SEC * 10
    ),
    true
  );
  assert.equal(await store.isActiveTickerOwner("CRM", job.workId), true);

  store.resetRefreshJobStoreForTests();
});

test("failed jobs suppress republishes until their cooldown expires", async () => {
  let timestamp = Date.parse("2026-08-05T05:00:00Z");
  let publishes = 0;
  store.resetRefreshJobStoreForTests({
    now: () => timestamp,
    createWorkId: () => FIRST_ID,
  });
  queue.setRefreshPublisherForTests(async () => {
    publishes++;
  });
  try {
    const first = await queue.requestTickerRefresh("AMD", "manual");
    assert.equal(first.publish, "accepted");
    await store.markRefreshJobFailed(
      first.workId,
      first.ticker,
      "provider_unavailable",
      "2026-08-05T05:05:00.000Z"
    );

    const retry = await queue.requestTickerRefresh("amd", "manual");
    assert.equal(retry.state, "failed");
    assert.equal(retry.publish, "suppressed");
    assert.equal(retry.workId, first.workId);
    assert.equal(publishes, 1);

    timestamp = Date.parse("2026-08-05T05:05:01.000Z");
  } finally {
    queue.setRefreshPublisherForTests(undefined);
    store.resetRefreshJobStoreForTests();
  }
});

test("worker payloads require canonical tickers and UUID work ids", () => {
  assert.deepEqual(
    queue.parseTickerRefreshPayload({ workId: FIRST_ID, ticker: "NVDA" }),
    { workId: FIRST_ID, ticker: "NVDA" }
  );
  assert.equal(
    queue.parseTickerRefreshPayload({ workId: FIRST_ID, ticker: " nvda " }),
    null
  );
  assert.equal(
    queue.parseTickerRefreshPayload({ workId: "not-a-uuid", ticker: "NVDA" }),
    null
  );
});

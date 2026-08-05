import "./no-live-keys";
import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { AnalysisDoc } from "../src/lib/market-data/types";

let store: typeof import("../src/lib/market-intelligence/job-store");
let worker: typeof import("../src/lib/market-intelligence/worker");

before(async () => {
  store = await import("../src/lib/market-intelligence/job-store");
  worker = await import("../src/lib/market-intelligence/worker");
});

const WORK_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_WORK_ID = "55555555-5555-4555-8555-555555555555";

function finalizeDependencyStubs(events: string[]) {
  const current: AnalysisDoc | null = null;
  return {
    getJob: async () => await store.getRefreshJob(WORK_ID),
    readAnalysis: async () => current,
    recordError: async () => {
      events.push("recordError");
    },
    selectCandidates: async () => {
      events.push("selectCandidates");
      return {
        articles: [],
        articleIds: [],
        contentFingerprint: "c",
        analysisFingerprint: "a",
      };
    },
    publishAnalysis: async () => {
      events.push("publishAnalysis");
      return true;
    },
    acquireLock: async () => true,
    releaseLock: async () => true,
    isActiveOwner: async () => true,
    revalidateTicker: () => {
      events.push("revalidate");
    },
  };
}

test("a duplicate/late finalizer callback no-ops once the first has claimed the job", async () => {
  store.resetRefreshJobStoreForTests({
    now: () => Date.parse("2026-08-05T05:00:00Z"),
    createWorkId: () => WORK_ID,
  });
  const { job } = await store.reserveRefreshJob("orcl");
  await store.markRefreshJobRunning(job.workId, job.ticker);

  const payload = { workId: job.workId, ticker: job.ticker };
  const retryAfter = "2026-08-05T05:05:00.000Z";

  const firstEvents: string[] = [];
  const first = await worker.finalizeTerminalFailure(
    payload,
    "refresh_transient_failure",
    retryAfter,
    finalizeDependencyStubs(firstEvents)
  );
  assert.equal(first.claimed, true);
  // No usable stored bundle exists, so finalizeFailedRefresh takes its
  // early-return branch and records an honest error rather than fabricating
  // a news-only bundle.
  assert.deepEqual(firstEvents, ["recordError", "revalidate"]);

  const failedJob = await store.getRefreshJob(job.workId);
  assert.equal(failedJob?.state, "failed");
  assert.equal(failedJob?.error, "refresh_transient_failure");

  const secondEvents: string[] = [];
  const second = await worker.finalizeTerminalFailure(
    payload,
    "qstash_delivery_exhausted",
    retryAfter,
    finalizeDependencyStubs(secondEvents)
  );
  assert.equal(second.claimed, false);
  // The loser must not touch the manifest, error state, or cache tag again.
  assert.deepEqual(secondEvents, []);

  const stillFailedJob = await store.getRefreshJob(job.workId);
  assert.equal(stillFailedJob?.error, "refresh_transient_failure");

  store.resetRefreshJobStoreForTests();
});

test("finalization can only be claimed while active:<ticker> still points at this workId", async () => {
  store.resetRefreshJobStoreForTests({
    now: () => Date.parse("2026-08-05T05:00:00Z"),
  });
  await store.acquireTickerLock("nflx-fence", "someone-else", 60);
  const claimed = await store.claimTerminalFinalization(
    OTHER_WORK_ID,
    "nflx-fence",
    "refresh_failed"
  );
  // No job exists for OTHER_WORK_ID at all, so the claim must fail closed.
  assert.equal(claimed, null);
  store.resetRefreshJobStoreForTests();
});

test("claimTerminalFinalization is a no-op once a job is already terminal", async () => {
  store.resetRefreshJobStoreForTests({
    now: () => Date.parse("2026-08-05T05:00:00Z"),
    createWorkId: () => WORK_ID,
  });
  const { job } = await store.reserveRefreshJob("ibm");
  await store.markRefreshJobRunning(job.workId, job.ticker);
  await store.markRefreshJobFailed(job.workId, job.ticker, "already_failed");

  const claimed = await store.claimTerminalFinalization(
    job.workId,
    job.ticker,
    "refresh_transient_failure",
    "2026-08-05T05:05:00.000Z"
  );
  assert.equal(claimed, null);
  const current = await store.getRefreshJob(job.workId);
  assert.equal(current?.error, "already_failed");

  store.resetRefreshJobStoreForTests();
});

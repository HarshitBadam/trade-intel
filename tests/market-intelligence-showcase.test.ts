import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  markRefreshJobFailed,
  resetRefreshJobStoreForTests,
} from "../src/lib/market-intelligence/job-store";
import {
  setRefreshPublisherForTests,
  type TickerRefreshPayload,
} from "../src/lib/market-intelligence/queue";
import {
  enqueueShowcaseRefreshes,
  isShowcaseScheduleHealthy,
  SHOWCASE_REFRESH_INTERVAL_MINUTES,
  SHOWCASE_STAGGER_SECONDS,
  type ShowcaseScheduleReport,
} from "../src/lib/market-intelligence/scheduler";
import { SHOWCASE_SYMBOLS } from "../src/lib/market-intelligence/showcase";

test("showcase scheduler publishes only canonical tickers with pacing", async () => {
  resetRefreshJobStoreForTests();
  const deliveries: { payload: TickerRefreshPayload; delay?: number }[] = [];
  setRefreshPublisherForTests(async (payload, delay) => {
    deliveries.push({ payload, delay });
  });
  try {
    const report = await enqueueShowcaseRefreshes();
    assert.equal(report.selected, 10);
    assert.equal(report.queued, 10);
    assert.equal(report.joined, 0);
    assert.equal(report.uncertain, 0);
    assert.equal(report.suppressed, 0);
    assert.equal(report.failed, 0);
    assert.deepEqual(
      deliveries.map(({ payload }) => payload.ticker),
      SHOWCASE_SYMBOLS
    );
    assert.deepEqual(
      deliveries.map(({ delay }) => delay ?? 0),
      SHOWCASE_SYMBOLS.map((_, index) => index * SHOWCASE_STAGGER_SECONDS)
    );
  } finally {
    setRefreshPublisherForTests();
    resetRefreshJobStoreForTests();
  }
});

test("showcase cadence keeps the last staggered conclusion inside the one-hour SLO", () => {
  const cycleSeconds = SHOWCASE_REFRESH_INTERVAL_MINUTES * 60;
  const finalDelaySeconds =
    (SHOWCASE_SYMBOLS.length - 1) * SHOWCASE_STAGGER_SECONDS;

  assert.equal(SHOWCASE_REFRESH_INTERVAL_MINUTES, 30);
  assert.ok(
    cycleSeconds + finalDelaySeconds < 60 * 60,
    "a healthy cycle must retain headroom before the 60-minute boundary"
  );
});

test("showcase scheduler classifies uncertain publishes separately from queued", async () => {
  resetRefreshJobStoreForTests();
  setRefreshPublisherForTests(async () => {
    throw new Error("response lost");
  });
  try {
    const report = await enqueueShowcaseRefreshes();
    assert.equal(report.selected, SHOWCASE_SYMBOLS.length);
    assert.equal(report.uncertain, SHOWCASE_SYMBOLS.length);
    assert.equal(report.queued, 0);
    assert.equal(report.joined, 0);
    assert.equal(report.suppressed, 0);
    assert.equal(report.failed, 0);
    for (const result of report.results) {
      assert.equal(result.state, "uncertain");
    }
  } finally {
    setRefreshPublisherForTests();
    resetRefreshJobStoreForTests();
  }
});

test("showcase scheduler counts suppressed cooldowns without treating them as queued", async () => {
  resetRefreshJobStoreForTests();
  let publishes = 0;
  setRefreshPublisherForTests(async () => {
    publishes++;
  });
  try {
    const first = await enqueueShowcaseRefreshes();
    assert.equal(first.queued, SHOWCASE_SYMBOLS.length);

    // Re-running immediately re-joins the still-active jobs from the first
    // run (none have failed yet), so this is a "joined" pass, not queued.
    const second = await enqueueShowcaseRefreshes();
    assert.equal(second.joined, SHOWCASE_SYMBOLS.length);
    assert.equal(second.queued, 0);
    assert.equal(second.failed, 0);
    assert.equal(publishes, SHOWCASE_SYMBOLS.length * 2);
  } finally {
    setRefreshPublisherForTests();
    resetRefreshJobStoreForTests();
  }
});

test("a run that is entirely queued and/or joined is healthy", async () => {
  resetRefreshJobStoreForTests();
  setRefreshPublisherForTests(async () => {});
  try {
    const allQueued = await enqueueShowcaseRefreshes();
    assert.equal(allQueued.queued, SHOWCASE_SYMBOLS.length);
    assert.equal(isShowcaseScheduleHealthy(allQueued), true);

    // Re-running immediately joins every still-active job from the first
    // pass instead of queueing fresh ones; that's still healthy.
    const allJoined = await enqueueShowcaseRefreshes();
    assert.equal(allJoined.joined, SHOWCASE_SYMBOLS.length);
    assert.equal(isShowcaseScheduleHealthy(allJoined), true);
  } finally {
    setRefreshPublisherForTests();
    resetRefreshJobStoreForTests();
  }
});

test("a mix of only queued and joined tickers is still healthy", () => {
  const report: ShowcaseScheduleReport = {
    selected: 10,
    queued: 4,
    joined: 6,
    uncertain: 0,
    suppressed: 0,
    failed: 0,
    results: [],
  };
  assert.equal(isShowcaseScheduleHealthy(report), true);
});

test("any uncertain, suppressed, or failed ticker makes the run unhealthy", () => {
  const base = {
    selected: 10,
    queued: 9,
    joined: 0,
    uncertain: 0,
    suppressed: 0,
    failed: 0,
    results: [] as ShowcaseScheduleReport["results"],
  };
  assert.equal(
    isShowcaseScheduleHealthy({ ...base, uncertain: 1 }),
    false,
    "a single uncertain handoff must not be papered over as healthy"
  );
  assert.equal(
    isShowcaseScheduleHealthy({ ...base, suppressed: 1 }),
    false,
    "a single suppressed (cooldown/budget) outcome must not be healthy"
  );
  assert.equal(
    isShowcaseScheduleHealthy({ ...base, failed: 1 }),
    false,
    "a single thrown failure must not be healthy"
  );
  // A combination of every non-healthy outcome, still unhealthy.
  assert.equal(
    isShowcaseScheduleHealthy({
      selected: 10,
      queued: 4,
      joined: 3,
      uncertain: 1,
      suppressed: 1,
      failed: 1,
      results: [],
    }),
    false
  );
  // Every ticker suppressed or failed with none queued/joined at all.
  assert.equal(
    isShowcaseScheduleHealthy({
      selected: 10,
      queued: 0,
      joined: 0,
      uncertain: 0,
      suppressed: 5,
      failed: 5,
      results: [],
    }),
    false
  );
});

test("a fully uncertain run reports honest counts and is unhealthy", async () => {
  resetRefreshJobStoreForTests();
  setRefreshPublisherForTests(async () => {
    throw new Error("response lost");
  });
  try {
    const report = await enqueueShowcaseRefreshes();
    assert.equal(report.uncertain, SHOWCASE_SYMBOLS.length);
    assert.equal(isShowcaseScheduleHealthy(report), false);
  } finally {
    setRefreshPublisherForTests();
    resetRefreshJobStoreForTests();
  }
});

test("a partially suppressed run is unhealthy even though most tickers joined", async () => {
  resetRefreshJobStoreForTests();
  setRefreshPublisherForTests(async () => {});
  try {
    const first = await enqueueShowcaseRefreshes();
    assert.equal(first.queued, SHOWCASE_SYMBOLS.length);
    assert.equal(isShowcaseScheduleHealthy(first), true);

    const failedTicker = SHOWCASE_SYMBOLS[0];
    const failedWorkId = first.results.find(
      (result) => result.ticker === failedTicker
    )?.workId;
    assert.ok(failedWorkId);
    await markRefreshJobFailed(
      failedWorkId!,
      failedTicker,
      "provider_unavailable",
      new Date(Date.now() + 60_000).toISOString()
    );

    const second = await enqueueShowcaseRefreshes();
    assert.equal(second.suppressed, 1);
    assert.equal(second.joined, SHOWCASE_SYMBOLS.length - 1);
    assert.equal(second.queued, 0);
    assert.equal(second.failed, 0);
    assert.equal(second.uncertain, 0);
    assert.equal(
      isShowcaseScheduleHealthy(second),
      false,
      "one suppressed ticker must make an otherwise-joined run unhealthy"
    );
  } finally {
    setRefreshPublisherForTests();
    resetRefreshJobStoreForTests();
  }
});

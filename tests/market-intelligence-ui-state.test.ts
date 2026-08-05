import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRetryAfterSec,
  deriveActiveRefreshState,
} from "../src/lib/market-intelligence/types";

test("computeRetryAfterSec renders a positive countdown from an absolute deadline", () => {
  const now = Date.parse("2026-08-05T05:00:00.000Z");
  assert.equal(
    computeRetryAfterSec("2026-08-05T05:00:30.000Z", now),
    30
  );
  assert.equal(
    computeRetryAfterSec("2026-08-05T05:00:00.400Z", now),
    1
  );
});

test("computeRetryAfterSec is honest about missing or elapsed cooldowns", () => {
  const now = Date.parse("2026-08-05T05:00:00.000Z");
  assert.equal(computeRetryAfterSec(undefined, now), undefined);
  assert.equal(computeRetryAfterSec("not-a-date", now), undefined);
  // Already in the past: nothing actionable to display.
  assert.equal(computeRetryAfterSec("2026-08-05T04:59:00.000Z", now), undefined);
});

test("deriveActiveRefreshState never collapses known outstanding work into idle", () => {
  assert.equal(deriveActiveRefreshState("running"), "running");
  assert.equal(deriveActiveRefreshState("queued"), "queued");
  // A lost/unknown poll response still implies the durable job is
  // outstanding, so it must default to "queued", never "idle".
  assert.equal(deriveActiveRefreshState(undefined), "queued");
});

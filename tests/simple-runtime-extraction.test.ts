import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSimpleEvidenceRequest,
  normalizeSimpleEvidencePlan,
} from "../src/lib/stocksage/simple-runtime";

test("normalizes the three evidence lanes without changing price pairs", () => {
  const plan = normalizeSimpleEvidencePlan({
    prices: [
      ["TSLA", "2026-01-01"],
      ["TSLA", "2026-08-12"],
      ["SpaceX", "2026-08-12"],
    ],
    news: ["Macquarie whistleblower allegations"],
    rankings: [["US", "2026-08-12"]],
  });

  assert.deepEqual(plan, {
    prices: [
      ["TSLA", "2026-01-01"],
      ["TSLA", "2026-08-12"],
      ["SpaceX", "2026-08-12"],
    ],
    news: ["Macquarie whistleblower allegations"],
    rankings: [["US", "2026-08-12"]],
  });
});

test("accepts a stale pairs completion as a defensive compatibility path", () => {
  assert.deepEqual(
    normalizeSimpleEvidencePlan({
      pairs: [["AAPL", "2026-08-12"]],
    }),
    {
      prices: [["AAPL", "2026-08-12"]],
      news: [],
      rankings: [],
    }
  );
});

test("prefers an explicitly populated prices lane over legacy pairs", () => {
  assert.deepEqual(
    normalizeSimpleEvidencePlan({
      prices: [["MSFT", "2026-08-12"]],
      pairs: [["AAPL", "2026-08-12"]],
      news: [],
      rankings: [],
    }).prices,
    [["MSFT", "2026-08-12"]]
  );
});

test("validates dates, markets, and bounded lane sizes", () => {
  assert.throws(() =>
    normalizeSimpleEvidencePlan({
      prices: [["AAPL", "2026-02-30"]],
      news: [],
      rankings: [],
    })
  );
  assert.throws(() =>
    normalizeSimpleEvidencePlan({
      prices: [],
      news: [],
      rankings: [["EU", "2026-08-12"]],
    })
  );
  assert.throws(() =>
    normalizeSimpleEvidencePlan({
      prices: [],
      news: ["one", "two", "three", "four"],
      rankings: [],
    })
  );
});

test("treats any populated evidence lane as a finance request", () => {
  assert.equal(
    hasSimpleEvidenceRequest({ prices: [], news: [], rankings: [] }),
    false
  );
  assert.equal(
    hasSimpleEvidenceRequest({
      prices: [],
      news: ["specific earnings investigation"],
      rankings: [],
    }),
    true
  );
  assert.equal(
    hasSimpleEvidenceRequest({
      prices: [],
      news: [],
      rankings: [["UNSPECIFIED", "2026-08-12"]],
    }),
    true
  );
});

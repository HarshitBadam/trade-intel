import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSimpleLlmConfig } from "../src/lib/config";
import { LlmRequestError } from "../src/lib/llm";
import {
  hasSimpleEvidenceRequest,
  normalizeSimpleEvidencePlan,
  shouldFallbackSimpleLlm,
} from "../src/lib/stocksage/simple-runtime";

test("selects provider defaults and allows an explicit model override", () => {
  assert.deepEqual(resolveSimpleLlmConfig(undefined, undefined), {
    provider: "cerebras",
    model: "gpt-oss-120b",
  });
  assert.deepEqual(resolveSimpleLlmConfig("groq", undefined), {
    provider: "groq",
    model: "qwen/qwen3.6-27b",
  });
  assert.deepEqual(resolveSimpleLlmConfig(" GROQ ", " custom/model "), {
    provider: "groq",
    model: "custom/model",
  });
});

test("falls back only for unavailable or transient LLM failures", () => {
  assert.equal(
    shouldFallbackSimpleLlm(new LlmRequestError("rate limited", { status: 429 })),
    true
  );
  assert.equal(
    shouldFallbackSimpleLlm(new LlmRequestError("provider error", { status: 503 })),
    true
  );
  assert.equal(
    shouldFallbackSimpleLlm(new LlmRequestError("network timeout")),
    true
  );
  assert.equal(
    shouldFallbackSimpleLlm(new LlmRequestError("bad request", { status: 400 })),
    false
  );
  assert.equal(shouldFallbackSimpleLlm(new Error("invalid JSON")), false);
});

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

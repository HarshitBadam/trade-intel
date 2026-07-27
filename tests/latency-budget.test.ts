import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import { answerChat } from "../src/lib/stocksage/chat";
import {
  createRequestBudget,
  LATENCY_BUDGET_MS,
  withDeadline,
} from "../src/lib/stocksage/budget";
import { decideTurn } from "../src/lib/stocksage/turn-decision";
import type { RetrievalProviders } from "../src/lib/stocksage/retrieve";

/**
 * Latency is proved by control flow, not by average timing: a provider that
 * never resolves must not be able to delay publication past the budget.
 */
function stalledProviders(): {
  providers: RetrievalProviders;
  abandoned: () => number;
} {
  let outstanding = 0;
  const stall = <T,>(value: T) =>
    new Promise<T>((resolve) => {
      outstanding += 1;
      // Far beyond any budget; if publication waits for this, the test fails.
      setTimeout(() => {
        outstanding -= 1;
        resolve(value);
      }, 30_000).unref?.();
    });
  return {
    providers: {
      quotes: () => stall([]),
      astra: () => stall([]),
      tavily: () => stall([]),
      fundamentals: () => stall([]),
      marketProxy: () => stall([]),
    },
    abandoned: () => outstanding,
  };
}

test("a stalled provider cannot push a regular answer past its budget", async () => {
  const { providers, abandoned } = stalledProviders();
  const startedAt = Date.now();
  const reply = await answerChat(
    { message: "How is Apple doing today?", history: [] },
    { retrievalProviders: providers }
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed <= LATENCY_BUDGET_MS.regular,
    `expected publication within ${LATENCY_BUDGET_MS.regular}ms, took ${elapsed}ms`
  );
  assert.ok(reply.text.trim().length > 0, "a grounded answer is still published");
  assert.ok(abandoned() > 0, "the abandoned provider work is left behind");
});

test("instant turns publish far inside the instant budget", async () => {
  const { providers } = stalledProviders();
  for (const message of [
    "sup boss",
    "place a buy order for 100 TSLA for me",
    "I am going to kill myself",
  ]) {
    const startedAt = Date.now();
    const reply = await answerChat(
      { message, history: [] },
      { retrievalProviders: providers }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed <= LATENCY_BUDGET_MS.instant,
      `"${message}" took ${elapsed}ms, over the ${LATENCY_BUDGET_MS.instant}ms instant budget`
    );
    assert.ok(reply.text.trim().length > 0);
    assert.equal(decideTurn({ message, history: [] }).decision.latencyClass, "instant");
  }
});

test("the budget reserves publication time and never goes negative", () => {
  const budget = createRequestBudget({
    latencyClass: "regular",
    startedAt: Date.now() - 4_900,
  });
  assert.ok(budget.remainingMs() <= 100);
  assert.equal(budget.publishableMs(), 0, "no room left to start a model call");
  assert.equal(budget.slice(10_000), budget.remainingMs());

  const expired = createRequestBudget({
    latencyClass: "regular",
    startedAt: Date.now() - 9_000,
  });
  assert.equal(expired.expired(), true);
  assert.equal(expired.remainingMs(), 0);
  assert.equal(expired.publishableMs(), 0);
});

test("withDeadline returns the fallback instead of awaiting a slow promise", async () => {
  const slow = new Promise<string>((resolve) => {
    setTimeout(() => resolve("late"), 5_000).unref?.();
  });
  const startedAt = Date.now();
  const value = await withDeadline(slow, 50, "fallback");
  assert.equal(value, "fallback");
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a rejected promise resolves to the fallback rather than throwing", async () => {
  const failing = Promise.reject(new Error("provider down"));
  assert.equal(await withDeadline(failing, 100, "fallback"), "fallback");
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decideTurn } from "../src/lib/stocksage/turn-decision";

const ROOT = resolve(import.meta.dirname, "..", "src", "lib", "stocksage");

function source(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8");
}

/**
 * The single-authority claim is only true if executors cannot quietly reach
 * for a second classifier. These are structural checks, not behavioral ones,
 * because a behavioral test would pass right up until someone adds a branch.
 */
test("the model executor never calls a routing or policy classifier", () => {
  for (const file of ["chat-model.ts", "chat-model-synthesis.ts"]) {
    const text = source(file);
    for (const forbidden of [
      "routeMessage",
      "evaluateDomainPolicy",
      "hardSafetyFloor",
      "classifyHighStakes",
      "detectCrisis",
    ]) {
      assert.ok(
        !text.includes(forbidden),
        `${file} must not call ${forbidden}; the frozen decision is the authority`
      );
    }
  }
});

test("only the decision module and its legacy fallback classify a turn", () => {
  const heuristics = source("chat-heuristics.ts");
  // The heuristics path keeps a classifier for the reversible "off" mode. It
  // has to stay quarantined inside functions named `legacy*`, so that reaching
  // for it anywhere else is visible in review.
  const declarations = [
    ...heuristics.matchAll(/^(?:export )?function (\w+)/gm),
  ];
  assert.ok(
    declarations.some(([, name]) => name === "legacyClassification"),
    "the legacy classifier must stay clearly named"
  );
  for (const call of heuristics.matchAll(/routeMessage\(/g)) {
    const enclosing = declarations
      .filter((declaration) => declaration.index! < call.index!)
      .at(-1);
    assert.match(
      enclosing?.[1] ?? "<module scope>",
      /^legacy/,
      `routeMessage in ${enclosing?.[1] ?? "module scope"} would be a second brain`
    );
  }
});

test("chat.ts publishes the authoritative decision rather than reclassifying", () => {
  const chat = source("chat.ts");
  assert.ok(chat.includes("decideTurn("), "chat.ts asks for the decision");
  assert.ok(
    !chat.includes("routeMessage("),
    "chat.ts must not route independently"
  );
});

test("a decision is frozen, so an executor cannot edit it in flight", () => {
  const { decision, context } = decideTurn({
    message: "How is Apple doing today?",
    history: [],
  });
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(context));
  assert.throws(() => {
    (decision as { retrievalAuthorized: boolean }).retrievalAuthorized = false;
  });
});

test("the same message yields the same decision every time", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  const message = "Compare Macquarie and the Aussie Big Four on risk";
  const first = decideTurn({ message, history: [] }, { now });
  const second = decideTurn({ message, history: [] }, { now });
  assert.deepEqual(first.decision, second.decision);
  assert.deepEqual(
    first.context.entities.map((entity) => entity.id),
    second.context.entities.map((entity) => entity.id)
  );
  assert.deepEqual(first.context.intervals, second.context.intervals);
});

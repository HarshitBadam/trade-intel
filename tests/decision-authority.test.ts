import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decideTurn } from "../src/lib/stocksage/router";

const ROOT = resolve(import.meta.dirname, "..", "src", "lib", "stocksage");

function source(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8");
}

test("router and context are the only turn authorities", () => {
  const router = source("router.ts");
  assert.match(router, /export function decideTurn\(/);
  assert.doesNotMatch(router, /process\.env|compatibility bridge/);
  assert.match(router, /from "\.\/context"/);
  assert.doesNotMatch(router, /resolveConversationState\(/);
  assert.match(source("context.ts"), /export function resolveTurnContext\(/);
  assert.equal(existsSync(resolve(ROOT, "turn-decision.ts")), false);
});

test("engine and answer cannot reclassify a frozen turn", () => {
  for (const file of ["engine.ts", "answer.ts"]) {
    const text = source(file);
    for (const forbidden of [
      "routeMessage(",
      "evaluateDomainPolicy(",
      "hardSafetyFloor(",
      "classifyHighStakes(",
      "detectCrisis(",
    ]) {
      assert.doesNotMatch(text, new RegExp(forbidden.replace("(", "\\(")));
    }
  }
});

test("router is the sole production caller of policy classification", () => {
  const allowed = new Set(["policy.ts", "router.ts"]);
  for (const file of readdirSync(ROOT)) {
    if (!file.endsWith(".ts") || allowed.has(file)) continue;
    const text = source(file);
    assert.doesNotMatch(text, /hardSafetyFloor\(|evaluateDomainPolicy\(/, file);
  }
});

test("chat is a stable wrapper around one engine", () => {
  const chat = source("chat.ts");
  assert.match(chat, /return runUnifiedEngine\(request, dependencies\)/);
  assert.doesNotMatch(
    chat,
    /process\.env|answerChatLegacy|answerWithModel|answerWithHeuristics/
  );
});

test("a decision is frozen and deterministic", () => {
  const request = {
    message: "Compare Macquarie and the Aussie Big Four on risk",
    history: [],
  };
  const now = new Date("2026-07-27T20:00:00.000Z");
  const first = decideTurn(request, { now });
  const second = decideTurn(request, { now });
  assert.ok(Object.isFrozen(first.decision));
  assert.ok(Object.isFrozen(first.context));
  assert.deepEqual(first, second);
  assert.throws(() => {
    (first.decision as { retrievalAuthorized: boolean }).retrievalAuthorized =
      false;
  });
});

test("regular synthesis caps candidates and Deep permits one repair", () => {
  assert.match(source("answer.ts"), /maxCandidates:\s*2/);
  const deep = source("deep/worker.ts");
  assert.match(deep, /maxCandidates:\s*1/);
  assert.match(deep, /modelAttempts:\s*"primary_only"/);
  assert.equal([...deep.matchAll(/correction:/g)].length, 1);
});

test("synthesis contention preserves fallback and isolates light/full lanes", () => {
  const synthesis = source("synthesis.ts");
  assert.match(
    synthesis,
    /laneKey = `\$\{candidate\.vendor\}:\$\{candidate\.model\}:\$\{args\.lane \?\? "full"\}`/
  );
  assert.match(synthesis, /LANE_WAIT_CEILING_MS/);
  assert.match(synthesis, /if \(!release\) continue/);
  assert.match(
    synthesis,
    /Breaker success records provider\/API availability/
  );
});

test("Deep repair has separate admission and is globally one-shot", () => {
  const synthesis = source("synthesis.ts");
  const repair = synthesis.slice(
    synthesis.indexOf("if (\n        args.correction"),
    synthesis.indexOf(
      'lastError = new Error("Synthesis output failed publication checks")'
    )
  );
  assert.match(repair, /!repairAttempted/);
  assert.match(repair, /isOpen\(candidate\.provider\)/);
  assert.match(repair, /isCoolingDown\(candidate\.quotaProvider\)/);
  assert.match(repair, /await rateLimit\(/);
  assert.match(repair, /deadline - Date\.now\(\) > 1_000/);
  assert.equal([...repair.matchAll(/repairAttempted = true/g)].length, 1);
});

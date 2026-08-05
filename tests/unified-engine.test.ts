import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { answerChat } from "../src/lib/stocksage/chat";
import { PROHIBITED_FALLBACK } from "../src/lib/stocksage/chat-shared";
import { runUnifiedEngine } from "../src/lib/stocksage/engine";
import type { RetrievalProviders } from "../src/lib/stocksage/evidence/retrieve";
import type { ChatRequest } from "../src/lib/stocksage/types";

const ROOT = resolve(import.meta.dirname, "..", "src", "lib", "stocksage");

function source(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8");
}

function request(message: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return { message, history: [], ...extra };
}

/**
 * A per-call, per-test synthesis-attempt counter injected through
 * `ChatDependencies.onSynthesisAttempt`, rather than reading module-global
 * state. Because each test constructs its own counter and passes it in as a
 * dependency, concurrent test runs (and concurrent production requests)
 * never share or race on the same counter.
 */
function synthesisAttemptCounter(): {
  onSynthesisAttempt: () => void;
  count: () => number;
} {
  let attempts = 0;
  return {
    onSynthesisAttempt: () => {
      attempts += 1;
    },
    count: () => attempts,
  };
}

function liveProviders(): RetrievalProviders {
  return {
    quotes: async () => [
      {
        ticker: "AAPL",
        venue: "NASDAQ",
        price: 200,
        dayPct: 1.2,
        weekPct: null,
        monthPct: null,
        mtdPct: null,
        ytdPct: null,
        yearPct: null,
        fewDaysPct: null,
        currency: "USD",
        isIndex: false,
        eod: false,
        asOf: new Date().toISOString(),
      } as never,
    ],
    astra: async () => [],
    tavily: async () => [],
  };
}

// --- one frozen turn -> one executor -------------------------------------

test("one frozen turn reaches the single answer executor by identity", async () => {
  const finalized: object[] = [];
  const executed: object[] = [];
  await runUnifiedEngine(request("How is Apple doing today?"), {
    retrievalProviders: liveProviders(),
    onTurnFinalized: (turn) => finalized.push(turn),
    onAnswerExecution: (turn) => executed.push(turn),
  });
  assert.equal(finalized.length, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0], finalized[0]);
  assert.ok(Object.isFrozen(finalized[0]));
  const turn = finalized[0] as { decision: object; context: object };
  assert.ok(Object.isFrozen(turn.decision));
  assert.ok(Object.isFrozen(turn.context));
});

test("a data-seeking regular turn is answered by the frozen decision without reclassifying", async () => {
  const reply = await runUnifiedEngine(
    request("How is Apple doing today?"),
    { retrievalProviders: liveProviders() }
  );
  assert.equal(reply.kind, "answer");
  assert.equal(reply.presentationMode, "current_finance");
});

// --- no routing in answer -------------------------------------------------

test("the answer executor never calls a routing, policy, or turn classifier", () => {
  const answer = source("answer.ts");
  for (const forbidden of [
    "routeMessage",
    "evaluateDomainPolicy",
    "hardSafetyFloor",
    "classifyHighStakes",
    "detectCrisis",
    "decideTurn(",
  ]) {
    assert.ok(
      !answer.includes(forbidden),
      `answer.ts must not call ${forbidden}; it consumes an already-frozen Turn`
    );
  }
});

test("the answer executor never retrieves; engine.ts is the only caller of executeEvidencePlan for the unified path", () => {
  const answer = source("answer.ts");
  assert.ok(
    !answer.includes("executeEvidencePlan"),
    "answer.ts must receive already-retrieved evidence, never retrieve itself"
  );
  const engine = source("engine.ts");
  assert.ok(engine.includes("executeEvidencePlan("));
});

// --- classifier reject -> zero synthesis ----------------------------------

test("a classifier rejection reaches zero synthesis stage entries", async () => {
  const tracker = synthesisAttemptCounter();
  const reply = await runUnifiedEngine(
    request("How is Apple doing today, and what should I do next?"),
    {
      retrievalProviders: liveProviders(),
      safetyClassifier: async () => ({
        action: "refuse",
        categories: ["UNSPECIFIED"],
      }),
      onSynthesisAttempt: tracker.onSynthesisAttempt,
    }
  );
  assert.equal(reply.presentationMode, undefined);
  assert.equal(reply.text, PROHIBITED_FALLBACK);
  assert.equal(
    tracker.count(),
    0,
    "a rejected turn must never reach the executor's synthesis stage"
  );
});

test("a classifier crisis verdict reaches zero synthesis stage entries", async () => {
  const tracker = synthesisAttemptCounter();
  const reply = await runUnifiedEngine(
    request("How is Apple doing today?"),
    {
      retrievalProviders: liveProviders(),
      safetyClassifier: async () => ({
        action: "crisis",
        kind: "self_harm",
        categories: ["SELF_HARM_CRISIS"],
      }),
      onSynthesisAttempt: tracker.onSynthesisAttempt,
    }
  );
  assert.equal(reply.presentationMode, undefined);
  assert.equal(tracker.count(), 0);
});

test("safety starts alongside retrieval and blocks the answer executor", async () => {
  const events: string[] = [];
  let releaseSafety!: () => void;
  const safetyGate = new Promise<void>((resolve) => {
    releaseSafety = resolve;
  });
  const pending = runUnifiedEngine(request("How is Apple doing today?"), {
    retrievalProviders: {
      ...liveProviders(),
      quotes: async () => {
        events.push("retrieval");
        releaseSafety();
        return liveProviders().quotes({} as never);
      },
    },
    safetyClassifier: async () => {
      events.push("safety");
      await safetyGate;
      events.push("safety_allowed");
      return { action: "allow", categories: [] };
    },
    onAnswerExecution: () => events.push("answer"),
  });
  await pending;
  assert.ok(events.indexOf("safety") < events.indexOf("safety_allowed"));
  assert.ok(events.indexOf("retrieval") < events.indexOf("safety_allowed"));
  assert.ok(events.indexOf("safety_allowed") < events.indexOf("answer"));
});

test("deterministic crisis and hard-policy turns call zero providers or models", async () => {
  for (const message of [
    "I want to end my life",
    "Should I sell my house and put it all into NVDA?",
  ]) {
    let retrievalCalls = 0;
    let safetyCalls = 0;
    const tracker = synthesisAttemptCounter();
    const providers: RetrievalProviders = {
      quotes: async () => {
        retrievalCalls += 1;
        return [];
      },
      fundamentals: async () => {
        retrievalCalls += 1;
        return [];
      },
      astra: async () => {
        retrievalCalls += 1;
        return [];
      },
      tavily: async () => {
        retrievalCalls += 1;
        return [];
      },
    };
    await runUnifiedEngine(request(message), {
      retrievalProviders: providers,
      safetyClassifier: async () => {
        safetyCalls += 1;
        return { action: "allow", categories: [] };
      },
      onSynthesisAttempt: tracker.onSynthesisAttempt,
    });
    assert.equal(retrievalCalls, 0, message);
    assert.equal(safetyCalls, 0, message);
    assert.equal(tracker.count(), 0, message);
  }
});

// --- no-LLM same executor --------------------------------------------------

test("the no-LLM path still enters the same executor's synthesis stage", async () => {
  const tracker = synthesisAttemptCounter();
  // Fundamentals-only, no quotes/sources: this clears every deterministic
  // and grounded branch (they key off quotes or specific news/outlook
  // phrasing) and stays "live" (so it never hits the zero-data floor
  // either), so the executor is guaranteed to reach its synthesis stage.
  const fundamentalsOnly: RetrievalProviders = {
    quotes: async () => [],
    fundamentals: async () => [
      {
        ticker: "AAPL",
        peTtm: 28.4,
        revenueGrowthTtmYoy: 6.1,
        beta: 1.2,
        earnings: null,
      } as never,
    ],
    astra: async () => [],
    tavily: async () => [],
  };
  const reply = await runUnifiedEngine(
    request("What's Apple's trailing P/E telling you about its valuation?"),
    { retrievalProviders: fundamentalsOnly, onSynthesisAttempt: tracker.onSynthesisAttempt }
  );
  assert.equal(reply.kind, "answer");
  // No synthesis LLM is configured in this test environment (see
  // tests/no-live-keys.ts), so `synthesizeWithFallback` throws immediately;
  // the executor still enters its synthesis stage before falling back
  // deterministically, proving there is no separate no-model code path.
  assert.equal(tracker.count(), 1);
});

test("concurrent requests never share synthesis-attempt state", async () => {
  const rejectedTracker = synthesisAttemptCounter();
  const fundamentalsOnly: RetrievalProviders = {
    quotes: async () => [],
    fundamentals: async () => [
      {
        ticker: "AAPL",
        peTtm: 28.4,
        revenueGrowthTtmYoy: 6.1,
        beta: 1.2,
        earnings: null,
      } as never,
    ],
    astra: async () => [],
    tavily: async () => [],
  };
  const synthesizingTracker = synthesisAttemptCounter();
  const [rejected, synthesizing] = await Promise.all([
    runUnifiedEngine(
      request("How is Apple doing today, and what should I do next?"),
      {
        retrievalProviders: liveProviders(),
        safetyClassifier: async () => ({
          action: "refuse",
          categories: ["UNSPECIFIED"],
        }),
        onSynthesisAttempt: rejectedTracker.onSynthesisAttempt,
      }
    ),
    runUnifiedEngine(
      request("What's Apple's trailing P/E telling you about its valuation?"),
      { retrievalProviders: fundamentalsOnly, onSynthesisAttempt: synthesizingTracker.onSynthesisAttempt }
    ),
  ]);
  assert.equal(rejected.presentationMode, undefined);
  assert.equal(synthesizing.kind, "answer");
  assert.equal(rejectedTracker.count(), 0);
  assert.equal(synthesizingTracker.count(), 1);
});

// --- max two model candidates ----------------------------------------------

test("the unified answer executor caps synthesis at two model candidates", () => {
  const answer = source("answer.ts");
  assert.match(
    answer,
    /maxCandidates:\s*2/,
    "the unified executor's regular synthesis must cap attempts at two"
  );
});

test("regular synthesis never requests a correction pass", () => {
  assert.ok(
    !source("answer.ts").includes("correction:"),
    "regular answers must fall through to a configured fallback or deterministic reply"
  );
  assert.ok(
    source("deep/worker.ts").includes("correction:"),
    "Deep Research retains its one permitted repair pass"
  );
});

test("synthesis.ts resolves exactly one Groq primary and one configured Groq fallback", () => {
  const synthesis = source("synthesis.ts");
  assert.ok(synthesis.includes("GROQ_CHAT_MODEL"));
  assert.ok(synthesis.includes("GROQ_FALLBACK_MODEL"));
  for (const removed of [
    "CEREBRAS_CHAT_MODEL",
    "GEMINI_CHAT_MODEL",
    "GROQ_OSS_MODEL",
    "GROQ_ANALYSIS_MODEL",
  ]) {
    assert.ok(
      !synthesis.includes(removed),
      `synthesis.ts must resolve only the Groq primary/fallback pair, not ${removed}`
    );
  }
  assert.match(
    synthesis,
    /const ordered = \[groqPrimary, groqFallback\];/,
    "the candidate pool must be exactly the Groq primary and fallback"
  );
});

// --- presentation fields -----------------------------------------------------

test("presentation fields are populated for instant, clarification, and answer turns", async () => {
  // Crisis is itself the safe output and sits outside the finance-answer
  // presentation surface (see `presentationModeFor`), so it intentionally
  // carries no presentation mode.
  const crisis = await runUnifiedEngine(
    request("I want to end my life")
  );
  assert.equal(crisis.presentationMode, undefined);

  const clarify = await runUnifiedEngine(
    request("What about the other Big 4 then?"),
    { retrievalProviders: liveProviders() }
  );
  assert.equal(clarify.presentationMode, "clarification");
  assert.ok(Array.isArray(clarify.clarificationChoices));
  assert.ok(clarify.clarificationChoices!.length > 0);
  assert.equal(typeof clarify.clarificationChoices![0].label, "string");

  const answer = await runUnifiedEngine(
    request("How is Apple doing today?"),
    { retrievalProviders: liveProviders() }
  );
  assert.equal(answer.presentationMode, "current_finance");
  assert.equal(typeof answer.presentationReason, "string");
});

test("presentation mode reflects the actually-published data status, not just the route", () => {
  const engine = source("engine.ts");
  assert.ok(
    engine.includes("presentationModeFor("),
    "engine.ts must derive presentation mode from the stable-mode mapping"
  );
  const answer = source("answer.ts");
  assert.match(
    answer,
    /presentationModeFor\(turn\.decision, reply\.dataStatus/,
    "answer.ts must derive presentation mode from the reply's own dataStatus"
  );
});

test("ChatPresentationMode uses the architecture's stable modes", () => {
  const chatShared = source("chat-shared.ts");
  for (const mode of [
    "social",
    "clarification",
    "stable_finance",
    "current_finance",
    "comparison",
    "limited_evidence",
    "no_evidence",
  ]) {
    assert.ok(
      chatShared.includes(`"${mode}"`),
      `presentationModeFor must be able to return "${mode}"`
    );
  }
});

test("chat.ts is a stable wrapper around the unified engine", () => {
  const chat = source("chat.ts");
  assert.match(chat, /return runUnifiedEngine\(request, dependencies\)/);
  assert.doesNotMatch(chat, /process\.env|answerChatLegacy|answerWithModel/);
});

test("answerChat always publishes unified presentation fields", async () => {
  const reply = await answerChat(request("How is Apple doing today?"), {
    retrievalProviders: liveProviders(),
  });
  assert.equal(reply.presentationMode, "current_finance");
});

// --- retrievalMs is measured, not hardcoded --------------------------------

test("retrievalMs reports measured wall-clock time", async () => {
  let measured: number | undefined;
  await runUnifiedEngine(request("How is Apple doing today?"), {
    retrievalProviders: {
      ...liveProviders(),
      quotes: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return liveProviders().quotes({} as never);
      },
    },
    onRetrievalComplete: (retrievalMs) => {
      measured = retrievalMs;
    },
  });
  assert.ok(measured !== undefined);
  assert.ok(measured >= 10, `expected measured retrieval time, received ${measured}ms`);
});

// --- cache-first retrieval is now the shared engine path --------------------

test("engine.ts identifies the shared cache-first retrieval path", () => {
  const engine = source("engine.ts");
  assert.ok(
    /cache-first/i.test(engine),
    "engine.ts should document the active cache-first retrieval semantics"
  );
});

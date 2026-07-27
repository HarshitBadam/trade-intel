import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { answerChat } from "../src/lib/stocksage/chat";
import {
  ACUTE_DISTRESS_RESPONSE,
  SELF_HARM_RESPONSE,
} from "../src/lib/stocksage/crisis";
import {
  beginInputSafetyCheck,
  classifyInputSafety,
  parseGuardVerdict,
  type SafetyClassifier,
  type SafetyVerdict,
} from "../src/lib/stocksage/safety-classifier";
import type { RetrievalProviders } from "../src/lib/stocksage/retrieve";
import type { ChatRequest } from "../src/lib/stocksage/types";

function setup(guard?: (message: string) => Promise<SafetyVerdict>) {
  const calls = { quotes: 0, astra: 0, tavily: 0, guard: 0 };
  const providers: RetrievalProviders = {
    quotes: async () => {
      calls.quotes += 1;
      return [
        {
          ticker: "NVDA",
          price: 202.38,
          asOf: "2026-07-17",
          dayPct: -2.45,
          fewDaysPct: -3.1,
          weekPct: -3.86,
          monthPct: -2.22,
          yearPct: 18.51,
        },
      ];
    },
    astra: async () => {
      calls.astra += 1;
      return [];
    },
    tavily: async () => {
      calls.tavily += 1;
      return [];
    },
  };
  const safetyClassifier: SafetyClassifier = async (message) => {
    calls.guard += 1;
    return guard ? guard(message) : { action: "allow" };
  };
  return { calls, providers, safetyClassifier };
}

function request(message: string): ChatRequest {
  return { message, history: [] };
}

const flaggedSelfHarm = async (): Promise<SafetyVerdict> =>
  parseGuardVerdict("unsafe\nS11");

test("guard output parses into the acted-on categories", () => {
  assert.deepEqual(parseGuardVerdict("safe"), { action: "allow" });
  assert.deepEqual(parseGuardVerdict("\nsafe\n"), { action: "allow" });
  assert.deepEqual(parseGuardVerdict("unsafe\nS11"), {
    action: "crisis",
    kind: "self_harm",
    categories: ["S11"],
  });
  assert.deepEqual(parseGuardVerdict("unsafe\r\nS6,S11"), {
    action: "crisis",
    kind: "self_harm",
    categories: ["S6", "S11"],
  });
  assert.deepEqual(parseGuardVerdict("unsafe\nS4"), {
    action: "refuse",
    categories: ["S4"],
  });
});

test("a same-line verdict is not mistaken for a clean result", () => {
  for (const raw of ["unsafe S11", "Unsafe: S11", "unsafe\tS11 "]) {
    assert.deepEqual(
      parseGuardVerdict(raw),
      { action: "crisis", kind: "self_harm", categories: ["S11"] },
      raw
    );
  }
});

test("specialized advice and financial-crime topics are not treated as unsafe", () => {
  for (const raw of [
    "unsafe\nS2",
    "unsafe\nS6",
    "unsafe\nS2,S6",
    "unsafe\nS5",
    "unsafe\nS8",
    "unsafe\nS10",
    "unsafe\nS12",
    "unsafe\nS13",
    "unsafe\nS14",
  ]) {
    assert.deepEqual(parseGuardVerdict(raw), { action: "allow" }, raw);
  }
});

test("unparseable guard output fails open", () => {
  for (const raw of ["", "   ", "I cannot help with that", "unsafe", "S11"]) {
    assert.deepEqual(parseGuardVerdict(raw), { action: "allow" }, raw);
  }
});

test("the classifier is inert without a configured key and never calls out", async () => {
  assert.deepEqual(await classifyInputSafety("i want to end things"), {
    action: "allow",
  });
});

test("the regex prefilter short-circuits without invoking the classifier", async () => {
  const { calls, providers, safetyClassifier } = setup(flaggedSelfHarm);
  const reply = await answerChat(
    request("BRO I WILL FUCKING KILL MY SELF IF YOU DOO NOT HELP ME"),
    { retrievalProviders: providers, safetyClassifier }
  );
  assert.equal(reply.text, SELF_HARM_RESPONSE);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0, guard: 0 });
});

test("classifier-flagged self-harm returns the crisis response with zero retrieval", async () => {
  const { calls, providers, safetyClassifier } = setup(flaggedSelfHarm);
  const reply = await answerChat(
    request("bro im gonna neck myself over this, seriously"),
    { retrievalProviders: providers, safetyClassifier }
  );
  assert.equal(reply.text, SELF_HARM_RESPONSE);
  assert.equal(reply.deepResearch, undefined);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0, guard: 1 });
});

test("distress-shaped social turns are safety-checked without delaying normal greetings", async () => {
  const { calls, providers, safetyClassifier } = setup(flaggedSelfHarm);
  const reply = await answerChat(request("hey, please help me, I have no hope"), {
    retrievalProviders: providers,
    safetyClassifier,
  });
  assert.equal(reply.text, SELF_HARM_RESPONSE);
  assert.equal(calls.guard, 1);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0, guard: 1 });
});

test("the classifier receives recent user context for ambiguous distress", async () => {
  let input = "";
  const { providers } = setup();
  await answerChat(
    {
      message: "please help me",
      history: [
        { role: "user", text: "I lost everything on this position" },
        { role: "ai", text: "Let's review the risks." },
      ],
    },
    {
      retrievalProviders: providers,
      safetyClassifier: async (message) => {
        input = message;
        return { action: "allow" };
      },
    }
  );
  assert.match(input, /I lost everything on this position/);
  assert.match(input, /please help me/);
});

test("a flagged turn that named a company still answers with support only", async () => {
  const { providers, safetyClassifier } = setup(flaggedSelfHarm);
  const reply = await answerChat(
    request("if NVDA drops again today im gonna neck myself"),
    { retrievalProviders: providers, safetyClassifier }
  );
  assert.equal(reply.text, SELF_HARM_RESPONSE);
  assert.doesNotMatch(reply.text, /202\.38|NVDA/);
  assert.deepEqual(reply.state?.entities ?? [], []);
});

test("an acute-distress verdict reuses the existing distress response", async () => {
  const { providers, safetyClassifier } = setup(async () => ({
    action: "crisis",
    kind: "acute_distress",
    categories: ["S11"],
  }));
  const reply = await answerChat(request("there is nowhere left for me to go"), {
    retrievalProviders: providers,
    safetyClassifier,
  });
  assert.equal(reply.text, ACUTE_DISTRESS_RESPONSE);
});

test("a refused category blocks the turn without a market answer", async () => {
  const { providers, safetyClassifier } = setup(async () =>
    parseGuardVerdict("unsafe\nS9")
  );
  const reply = await answerChat(request("How is Nvidia doing today?"), {
    retrievalProviders: providers,
    safetyClassifier,
  });
  assert.match(reply.text, /can’t help with that/i);
  assert.doesNotMatch(reply.text, /202\.38/);
});

test("allowed categories leave a legitimate finance question untouched", async () => {
  for (const raw of ["unsafe\nS6", "unsafe\nS2", "safe"]) {
    const { calls, providers, safetyClassifier } = setup(async () =>
      parseGuardVerdict(raw)
    );
    const reply = await answerChat(
      request("Should I be worried about Nvidia's valuation risk today?"),
      { retrievalProviders: providers, safetyClassifier }
    );
    assert.doesNotMatch(reply.text, /can’t help with that/i);
    assert.doesNotMatch(reply.text, /Lifeline/);
    assert.equal(calls.guard, 1, raw);
    assert.ok(calls.quotes > 0, raw);
  }
});

test("a classifier failure falls through to the normal answer", async () => {
  const { calls, providers, safetyClassifier } = setup(async () => {
    throw new Error("guard exploded");
  });
  const reply = await answerChat(request("What is Nvidia trading at?"), {
    retrievalProviders: providers,
    safetyClassifier,
  });
  assert.match(reply.text, /\$202\.38/);
  assert.equal(calls.guard, 1);
});

test("a hung classifier resolves to allow at the deadline", async () => {
  const startedAt = Date.now();
  const verdict = await beginInputSafetyCheck(
    "anything",
    () => new Promise<SafetyVerdict>(() => {})
  );
  assert.deepEqual(verdict, { action: "allow" });
  assert.ok(Date.now() - startedAt >= 1_400);
});

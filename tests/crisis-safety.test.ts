import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { detectCrisis } from "../src/lib/stocksage/crisis";
import { resolveConversationState } from "../src/lib/stocksage/entities";
import { routeMessage } from "../src/lib/stocksage/intent";
import { evaluateDomainPolicy } from "../src/lib/stocksage/policy";
import { resolveTickers } from "../src/lib/tickers";

function routeFor(message: string) {
  const resolution = resolveConversationState(message, undefined, []);
  return routeMessage({
    message,
    entities: resolution.entities,
    state: resolution.state,
  });
}

const SHOUTED_CRISIS = "BRO I WILL FUCKING KILL MY SELF IF YOU DOO NOT HELP ME";

const selfHarm = [
  SHOUTED_CRISIS,
  "i want to kill myself",
  "KILLL MYSELF",
  "i think about ending it all",
  "im going to take my own life",
  "i dont want to live anymore",
  "i can't go on",
  "thinking about self harm",
  "i'd be better off dead",
];

const distress = [
  "Please man I have no other fucking option FUCKKKK",
  "this is my last chance",
  "i'm desperate, i will lose everything",
];

const benign = [
  "How is Nvidia doing",
  "Compare AAPL and MSFT on valuation",
  "This stock is killing my portfolio",
  "The selloff was brutal, everything is down",
  "Is the AI trade dead?",
];

for (const message of selfHarm) {
  test(`self-harm detected: ${message}`, () => {
    assert.equal(detectCrisis(message), "self_harm");
  });
}

for (const message of distress) {
  test(`acute distress detected: ${message}`, () => {
    assert.equal(detectCrisis(message), "acute_distress");
  });
}

for (const message of benign) {
  test(`no crisis flagged: ${message}`, () => {
    assert.equal(detectCrisis(message), null);
  });
}

test("crisis language short-circuits the domain policy", () => {
  const decision = evaluateDomainPolicy(SHOUTED_CRISIS, []);
  assert.equal(decision.action, "respond");
  assert.equal(decision.reasonCode, "explicit_self_harm");
  assert.match(decision.response ?? "", /Lifeline/);
});

test("shouted prose yields no tickers", () => {
  assert.deepEqual(resolveTickers(SHOUTED_CRISIS), []);
});

test("everyday words are not tickers without a cue", () => {
  assert.deepEqual(resolveTickers("bro can YOU help ME"), []);
});

test("an explicit cue still resolves word-shaped tickers", () => {
  assert.deepEqual(resolveTickers("what is the $BRO price"), ["BRO"]);
  assert.deepEqual(resolveTickers("compare BRO and DOO"), ["BRO", "DOO"]);
});

test("a greeting with a throwaway insult stays on the instant social path", () => {
  for (const message of [
    "Yo fuckass whats up",
    "yo dickhead how's it going",
    "hey bot, sup",
  ]) {
    assert.equal(
      routeFor(message).route,
      "social",
      message
    );
  }
});

test("near-miss greetings and thanks stay off the model path", () => {
  for (const message of [
    "How are you doing?",
    "how are you holding up",
    "Thanks so much!",
    "thanks a lot man",
    "cool cool",
    "cool, thanks",
  ]) {
    assert.equal(routeFor(message).route, "social", message);
  }
});

test("crisis language outranks the social path", () => {
  assert.equal(
    routeFor(SHOUTED_CRISIS).reasonCode,
    "explicit_self_harm_language"
  );
});

test("real questions do not fall into the social path", () => {
  assert.notEqual(
    routeFor("hey, how is Nvidia doing today").route,
    "social"
  );
});

test("ordinary ticker asks still resolve", () => {
  assert.deepEqual(
    resolveTickers("How is NVDA tracking against AMD").sort(),
    ["AMD", "NVDA"]
  );
  assert.deepEqual(resolveTickers("IS NVDA A BUY"), ["NVDA"]);
  assert.deepEqual(resolveTickers("AAPL MSFT NVDA GOOGL TSLA", 5), [
    "AAPL",
    "MSFT",
    "NVDA",
    "GOOGL",
    "TSLA",
  ]);
});

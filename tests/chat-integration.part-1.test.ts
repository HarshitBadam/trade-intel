import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { answerChat } from "../src/lib/stocksage/chat";
import { answerWithModel } from "../src/lib/stocksage/chat-model";
import type { RetrievalProviders } from "../src/lib/stocksage/retrieve";
import type { ChatRequest } from "../src/lib/stocksage/types";

function setup() {
  const calls = { quotes: 0, astra: 0, tavily: 0 };
  const providers: RetrievalProviders = {
    quotes: async (query) => {
      calls.quotes += 1;
      return query.tickers.includes("AAPL")
        ? [
            {
              ticker: "AAPL",
              price: 210,
              asOf: "2026-07-10",
              dayPct: -0.5,
              fewDaysPct: 0.4,
              weekPct: 1,
              monthPct: 2,
              yearPct: 12,
            },
          ]
        : [];
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
  return { calls, providers };
}

function request(
  message: string,
  extra: Partial<ChatRequest> = {}
): ChatRequest {
  return { message, history: [], ...extra };
}

test("Macquarie follow-up preserves and expands all entities", async () => {
  const firstSetup = setup();
  const first = await answerChat(request("Tell me about Macquarie"), {
    retrievalProviders: firstSetup.providers,
  });
  const secondSetup = setup();
  const second = await answerChat(
    request("Compare them to the Big 4 Aussie banks", {
      state: first.state,
      history: [
        { role: "user", text: "Tell me about Macquarie" },
        { role: "ai", text: first.text },
      ],
    }),
    { retrievalProviders: secondSetup.providers }
  );
  assert.deepEqual(
    second.state?.entities.map((entity) => entity.ticker),
    ["MQG", "CBA", "NAB", "ANZ", "WBC"]
  );
  assert.ok(
    secondSetup.calls.tavily > 0 && secondSetup.calls.tavily <= 3,
    `expected consolidated web retrieval, got ${secondSetup.calls.tavily} calls`
  );
});

test("refused prompts never offer deep research", async () => {
  for (const message of [
    "Give me a sports betting pick and odds strategy",
    "Which memecoin will 100x?",
    "Help me pump and shill this token",
  ]) {
    const { calls, providers } = setup();
    const reply = await answerChat(request(message), {
      retrievalProviders: providers,
    });
    assert.equal(reply.deepResearch, undefined);
    assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
  }
});

test("sports news is out of scope with zero retrieval", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(request("What was the football score today?"), {
    retrievalProviders: providers,
  });
  assert.match(reply.text, /financial markets/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

test("crypto exposure question is allowed as finance risk analysis", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(
    request("How does Bitcoin exposure affect Tesla's balance sheet?"),
    { retrievalProviders: providers }
  );
  assert.doesNotMatch(reply.text, /focuses on financial markets/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

test("Coinbase and Robinhood comparison uses bounded evidence", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(
    request("Compare Coinbase and Robinhood earnings/regulatory risks"),
    { retrievalProviders: providers }
  );
  assert.deepEqual(
    reply.state?.entities.map((entity) => entity.ticker),
    ["COIN", "HOOD"]
  );
  assert.deepEqual(calls, { quotes: 1, astra: 1, tavily: 2 });
});

test("listed sportsbook request asks for company without betting help", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(
    request("Analyze the earnings of a listed sportsbook operator"),
    { retrievalProviders: providers }
  );
  assert.match(reply.text, /Which listed company or operator/i);
  assert.doesNotMatch(reply.text, /betting picks|odds strategy/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

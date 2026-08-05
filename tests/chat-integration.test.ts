import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { answerChat } from "../src/lib/stocksage/chat";
import type { RetrievalProviders } from "../src/lib/stocksage/evidence/retrieve";
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

test("greeting uses social fast path with zero providers", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(request("Hello bro..."), {
    retrievalProviders: providers,
  });
  assert.match(reply.text, /Hey/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
  assert.equal(reply.deepResearch, undefined);
});
test("casual greeting and goodbye use social fast paths", async () => {
  for (const message of [
    "sup boss",
    "Wassup whats gucci my ---",
    "Hey again, I'm back.",
    "gotcha",
    "aight gucci then",
    "bye boss",
    "bye for now",
    "goodbye, thanks",
  ]) {
    const { calls, providers } = setup();
    const reply = await answerChat(request(message), {
      retrievalProviders: providers,
    });
    assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
    assert.equal(reply.deepResearch, undefined);
  }
});

test("forward house-sale concentration prompt uses current typoed entity", async () => {
  const prior = await answerChat(request("How is IXIC doing?"), {
    retrievalProviders: setup().providers,
  });
  const { calls, providers } = setup();
  const reply = await answerChat(
    request(
      "Should I sell my house and deposite it all into macquaire and trusut them will be make me a millionaire?",
      { state: prior.state }
    ),
    { retrievalProviders: providers }
  );
  assert.equal(reply.deepResearch, undefined);
  assert.match(reply.text, /concentrat|remaining savings|money you'd genuinely miss/i);
  assert.match(reply.text, /licensed financial adviser|adviser/i);
  assert.deepEqual(
    reply.state?.entities.map((entity) => entity.ticker),
    ["MQG"]
  );
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

test("news ask with a quote present still reaches the grounded cited answer", async () => {
  const publishedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const providers: RetrievalProviders = {
    quotes: async () => [
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
    ],
    astra: async (query) => [
      {
        kind: "astra",
        title: "Nvidia Blackwell shipments accelerate",
        outlet: "Example Markets",
        publishedAt,
        url: "https://example.com/nvidia-blackwell",
        excerpt:
          "Nvidia announced that Blackwell demand and shipments are accelerating into the next product cycle.",
        entityIds: query.entityIds,
        criteria: query.criteria,
        queryId: query.id,
      },
    ],
    tavily: async () => [],
  };
  const reply = await answerChat(
    request("What's the latest cited Nvidia news?"),
    { retrievalProviders: providers }
  );
  assert.doesNotMatch(reply.text, /Market snapshot/i);
  assert.match(reply.text, /Nvidia Blackwell shipments accelerate/);
  assert.ok(
    reply.citationUrls?.includes("https://example.com/nvidia-blackwell")
  );
});

test("social-only recovery after finance uses zero providers and keeps state", async () => {
  const finance = await answerChat(request("Compare Apple and Microsoft"), {
    retrievalProviders: setup().providers,
  });
  const replies: string[] = [];
  for (const message of [
    "gucci, sayonara",
    "that was actually helpful",
    "we good?",
  ]) {
    const { calls, providers } = setup();
    const reply = await answerChat(
      request(message, { state: finance.state }),
      { retrievalProviders: providers }
    );
    replies.push(reply.text);
    assert.doesNotMatch(reply.text, /over capacity|analysis engine/i);
    assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
    assert.deepEqual(
      reply.state?.entities.map((entity) => entity.ticker),
      ["AAPL", "MSFT"]
    );
  }
  assert.equal(new Set(replies).size, replies.length);
});

test("creative request and farewell bypass inherited finance state", async () => {
  const finance = await answerChat(request("What's the latest Nvidia news?"), {
    retrievalProviders: setup().providers,
  });
  const history = [
    { role: "user" as const, text: "What's the latest Nvidia news?" },
    { role: "ai" as const, text: finance.text },
  ];

  const creativeSetup = setup();
  const creative = await answerChat(
    request("Write a haiku about Nvidia's price.", {
      state: finance.state,
      history,
    }),
    { retrievalProviders: creativeSetup.providers }
  );
  assert.match(creative.text, /financial markets/i);
  assert.doesNotMatch(creative.text, /fresh market data|try again|research deeper/i);
  assert.equal(creative.deepResearch, undefined);
  assert.equal(creative.dataStatus, "full");
  assert.deepEqual(creativeSetup.calls, { quotes: 0, astra: 0, tavily: 0 });
  assert.equal(creative.state?.entities[0]?.ticker, "NVDA");

  const farewellSetup = setup();
  const farewell = await answerChat(
    request("All good then, sayonara.", {
      state: creative.state,
      history: [
        ...history,
        { role: "user", text: "Write a haiku about Nvidia's price." },
        { role: "ai", text: creative.text },
      ],
    }),
    { retrievalProviders: farewellSetup.providers }
  );
  assert.match(farewell.text, /sayonara|catch you|take it easy|later|all the best|go well/i);
  assert.doesNotMatch(farewell.text, /fresh market data|try again|research deeper/i);
  assert.equal(farewell.deepResearch, undefined);
  assert.equal(farewell.dataStatus, "full");
  assert.deepEqual(farewellSetup.calls, { quotes: 0, astra: 0, tavily: 0 });
  assert.equal(farewell.state?.entities[0]?.ticker, "NVDA");
});

test("development follow-up with active entity retrieves evidence", async () => {
  const state = (
    await answerChat(request("What's the latest Nvidia news?"), {
      retrievalProviders: setup().providers,
    })
  ).state;
  const { calls, providers } = setup();
  await answerChat(
    request("Which development matters most for investors?", { state }),
    { retrievalProviders: providers }
  );
  assert.equal(calls.astra, 1);
  assert.equal(calls.tavily, 1);
});

test("capability questions use the social help path", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(
    request("what can you actually help me with?"),
    { retrievalProviders: providers }
  );
  assert.match(reply.text, /explain finance concepts/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

test("listed sportsbook company questions remain finance analysis", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(
    request("What is up with DraftKings earnings?"),
    { retrievalProviders: providers }
  );
  assert.equal(reply.state?.entities[0]?.ticker, "DKNG");
  assert.deepEqual(calls, { quotes: 1, astra: 1, tavily: 1 });
});

test("profanity alone stays conversationally scoped without retrieval", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(request("screw everything."), {
    retrievalProviders: providers,
  });
  assert.match(reply.text, /financial markets/i);
  assert.doesNotMatch(reply.text, /Lifeline|emergency/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

test("frustration and bot abuse use the deterministic social path", async () => {
  for (const message of [
    "you're not being helpful",
    "you are a useless piece of shit bot",
  ]) {
    const { calls, providers } = setup();
    const reply = await answerChat(request(message), {
      retrievalProviders: providers,
    });
    assert.match(reply.text, /fair|frustrating|another shot|retry/i);
    assert.equal(reply.deepResearch, undefined);
    assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
  }
});

test("prior finance state does not authorize later off-topic abuse", async () => {
  const firstSetup = setup();
  const first = await answerChat(request("What happened to Apple today?"), {
    retrievalProviders: firstSetup.providers,
  });
  for (const message of ["fuck this shit", "you stupid idiot"]) {
    const { calls, providers } = setup();
    const reply = await answerChat(
      request(message, { state: first.state }),
      { retrievalProviders: providers }
    );
    assert.match(reply.text, /financial markets|fair|another shot|retry/i);
    assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
  }
});

test("unrelated new topics never wipe inherited comparison state", async () => {
  const initialSetup = setup();
  const comparison = await answerChat(
    request("Compare Apple and Microsoft"),
    { retrievalProviders: initialSetup.providers }
  );
  for (const message of ["What is the weather today?", "Tell me a joke"]) {
    const { calls, providers } = setup();
    const reply = await answerChat(
      request(message, { state: comparison.state }),
      { retrievalProviders: providers }
    );
    assert.match(reply.text, /financial markets/i);
    assert.deepEqual(
      reply.state?.entities.map((entity) => entity.ticker),
      ["AAPL", "MSFT"]
    );
    assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
  }
});

test("Python loop is redirected without retrieval", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(
    request(
      'Screw everything what is the output of this python script: for i in range(100) print("fuck")'
    ),
    { retrievalProviders: providers }
  );
  assert.match(reply.text, /financial markets/i);
  assert.doesNotMatch(reply.text, /SyntaxError|missing colon/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
  assert.equal(reply.deepResearch, undefined);
});

test("stable P/E explanation uses no retrieval", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(request("What is a P/E ratio?"), {
    retrievalProviders: providers,
  });
  assert.match(reply.text, /share price divided by its earnings per share/i);
  assert.deepEqual(calls, { quotes: 0, astra: 0, tavily: 0 });
});

test("current price uses quotes plus Astra context", async () => {
  const { calls, providers } = setup();
  const reply = await answerChat(request("What is Apple trading at?"), {
    retrievalProviders: providers,
  });
  assert.match(reply.text, /\$210\.00/);
  assert.match(reply.text, /2026-07-10/);
  assert.deepEqual(calls, { quotes: 1, astra: 1, tavily: 0 });
});

test("current company event uses planned evidence providers", async () => {
  const { calls, providers } = setup();
  await answerChat(request("What happened to Apple today?"), {
    retrievalProviders: providers,
  });
  assert.deepEqual(calls, { quotes: 1, astra: 1, tavily: 1 });
});

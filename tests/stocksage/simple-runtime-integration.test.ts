import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceInput } from "../../src/lib/stocksage/citations";
import type { MarketRankingPacket } from "../../src/lib/market-data/market-rankings";
import {
  runSimpleChatAdapter,
  type FocusedNewsBundle,
  type MarketPacket,
  type SimpleCompositionPayload,
  type SimpleEvidencePlan,
} from "../../src/lib/stocksage/simple-runtime";

const NOW = new Date("2026-08-12T22:00:00.000Z");

function packet(ticker: string, entityId = `ticker:${ticker}`): MarketPacket {
  return {
    entityId,
    name: ticker,
    ticker,
    calendar: "US",
    status: "complete",
    provider: "test",
    instrumentSymbol: ticker,
    currency: "USD",
    requestedPoints: [
      { requestedDate: "2026-08-12", session: "2026-08-12", close: 100 },
    ],
    firstClose: 95,
    lastClose: 100,
    returnPct: 5.2631578947,
    returnKind: "single_session",
  };
}

function generalSource(): EvidenceInput {
  return {
    kind: "tavily",
    title: "General company update",
    outlet: "example.com",
    url: "https://example.com/general-update",
    excerpt: "A broad company update.",
  };
}

function emptyFocused(): FocusedNewsBundle {
  return { evidence: [], outcomes: [] };
}

function availableUsRanking(): MarketRankingPacket {
  return {
    market: "US",
    requestedDate: "2026-08-12",
    session: "2026-08-12",
    previousSession: "2026-08-11",
    mode: "completed_session",
    metric: "adjusted_close_to_close",
    status: "available",
    provider: "polygon",
    gainers: [
      {
        ticker: "AAPL",
        close: 110,
        previousClose: 100,
        change: 10,
        returnPct: 10,
      },
    ],
    losers: [
      {
        ticker: "MSFT",
        close: 90,
        previousClose: 100,
        change: -10,
        returnPct: -10,
      },
    ],
  };
}

test("social replies distinguish greetings, thanks, and farewells", async () => {
  const greeting =
    "Hey, good to see you. What company or market should we look at?";
  const acknowledgement =
    "No worries. Let me know if you want to look at anything else.";
  const farewell =
    "Take care. Come back anytime you want to look at a company or market.";
  for (const [message, expected] of [
    ["Nihao", greeting],
    ["Helo", greeting],
    ["hlelo", greeting],
    ["Thanks Mate", acknowledgement],
    ["Thanks a lot!!", acknowledgement],
    ["Thank you so much", acknowledgement],
    ["Thanks for the help", acknowledgement],
    ["thnaks", acknowledgement],
    ["thnak you", acknowledgement],
    ["dass good", acknowledgement],
    ["All good then", farewell],
    ["thats enough I gues", farewell],
    ["bye yaar", farewell],
    ["byee", farewell],
    ["goodby", farewell],
    ["see yaa", farewell],
    ["Sayonara", farewell],
  ] as const) {
    const reply = await runSimpleChatAdapter(
      { message, history: [] },
      {
        extractPlan: async () => {
          throw new Error("social messages should not reach extraction");
        },
      }
    );
    assert.equal(reply.text, expected, message);
    assert.equal(reply.presentationMode, "social", message);
  }
});

test("prices keep the existing market and general-news path unchanged", async () => {
  const plan: SimpleEvidencePlan = {
    prices: [["TSLA", "2026-08-12"]],
    news: [],
    rankings: [],
  };
  let generalNewsCalls = 0;
  let capturedPayload: SimpleCompositionPayload | undefined;
  const reply = await runSimpleChatAdapter(
    { message: "How is Tesla doing?", history: [] },
    {
      now: NOW,
      extractPlan: async () => plan,
      retrieveMarket: async (pairs) => {
        assert.deepEqual(
          pairs.map(({ entity, date }) => [entity.ticker, date]),
          [["TSLA", "2026-08-12"]]
        );
        return [packet("TSLA")];
      },
      retrieveGeneralNews: async (_request, entities, dates) => {
        generalNewsCalls += 1;
        assert.deepEqual(entities.map((entity) => entity.ticker), ["TSLA"]);
        assert.deepEqual(dates, ["2026-08-12"]);
        return [generalSource()];
      },
      retrieveFocusedNews: async (queries) => {
        assert.deepEqual(queries, []);
        return emptyFocused();
      },
      retrieveRankingOutcomes: async (requests) => {
        assert.deepEqual(requests, []);
        return [];
      },
      composeAnswer: async () => "Tesla answer.",
      onCompositionPayload: (payload) => {
        capturedPayload = payload;
      },
    }
  );

  assert.equal(generalNewsCalls, 1);
  assert.deepEqual(capturedPayload?.extractedPrices, plan.prices);
  assert.equal(reply.text, "Tesla answer.");
  assert.equal(reply.dataStatus, "full");
  assert.equal(reply.live, true);
});

test("focused news is supplemental and preserves no-results status for composition", async () => {
  const query = "Macquarie whistleblower allegations";
  let capturedPayload: SimpleCompositionPayload | undefined;
  const reply = await runSimpleChatAdapter(
    {
      message: "What about the Macquarie whistleblower story?",
      history: [],
    },
    {
      now: NOW,
      extractPlan: async () => ({
        prices: [["MQG", "2026-08-12"]],
        news: [query],
        rankings: [],
      }),
      retrieveMarket: async () => [packet("MQG")],
      retrieveGeneralNews: async () => [generalSource()],
      retrieveFocusedNews: async () => ({
        evidence: [],
        outcomes: [
          {
            query,
            status: "no_results",
            evidenceCount: 0,
          },
        ],
      }),
      retrieveRankingOutcomes: async () => [],
      composeAnswer: async ({ focusedNews }) => {
        assert.equal(focusedNews.outcomes[0]?.status, "no_results");
        return "I couldn't find reliable reporting about the Macquarie whistleblower story.";
      },
      onCompositionPayload: (payload) => {
        capturedPayload = payload;
      },
    }
  );

  assert.equal(
    capturedPayload?.focusedNewsRequests[0]?.status,
    "no_results"
  );
  assert.match(reply.text, /couldn't find reliable reporting/i);
  assert.equal(reply.dataStatus, "limited");
});

test("focused provider failure remains distinct and retryable", async () => {
  const reply = await runSimpleChatAdapter(
    {
      message: "What about the Macquarie whistleblower story?",
      history: [],
    },
    {
      now: NOW,
      extractPlan: async () => ({
        prices: [["MQG", "2026-08-12"]],
        news: ["Macquarie whistleblower allegations"],
        rankings: [],
      }),
      retrieveMarket: async () => [],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async () => ({
        evidence: [],
        outcomes: [
          {
            query: "Macquarie whistleblower allegations",
            status: "unavailable",
            reason: "http_503",
            evidenceCount: 0,
          },
        ],
      }),
      retrieveRankingOutcomes: async () => [],
      composeAnswer: async () =>
        "Focused news search is temporarily unavailable.",
    }
  );

  assert.match(reply.text, /temporarily unavailable/i);
  assert.equal(reply.dataStatus, "unavailable");
  assert.equal(reply.retryable, true);
});

test("ranking-only US turns publish compact evidence as a full answer", async () => {
  let capturedPayload: SimpleCompositionPayload | undefined;
  const reply = await runSimpleChatAdapter(
    { message: "Top and bottom US performers today", history: [] },
    {
      now: NOW,
      extractPlan: async () => ({
        prices: [],
        news: [],
        rankings: [["US", "2026-08-12"]],
      }),
      retrieveMarket: async () => [],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async () => emptyFocused(),
      retrieveRankingOutcomes: async (requests) => [
        {
          request: requests[0],
          status: "available",
          alternatives: ["compare_named_securities"],
          evidence: availableUsRanking(),
        },
      ],
      composeAnswer: async () => "| Top | Return |\n| --- | --- |\n| AAPL | +10% |",
      onCompositionPayload: (payload) => {
        capturedPayload = payload;
      },
    }
  );

  assert.equal(capturedPayload?.rankingEvidence.length, 1);
  assert.equal(reply.dataStatus, "full");
  assert.equal(reply.presentationMode, "comparison");
  assert.equal(reply.live, true);
});

test("ASX-wide ranking gives the composer a structured capability outcome", async () => {
  let composed = false;
  const reply = await runSimpleChatAdapter(
    { message: "Rank the ASX performers today", history: [] },
    {
      now: NOW,
      extractPlan: async () => ({
        prices: [],
        news: [],
        rankings: [["ASX", "2026-08-12"]],
      }),
      retrieveMarket: async () => [],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async () => emptyFocused(),
      composeAnswer: async ({ rankingOutcomes }) => {
        composed = true;
        assert.equal(rankingOutcomes[0]?.status, "unsupported");
        assert.equal(
          rankingOutcomes[0]?.reason,
          "asx_market_wide_unsupported"
        );
        return "StockSage can’t currently rank the entire ASX. I can summarize the broader market or compare named ASX companies.";
      },
    }
  );

  assert.equal(composed, true);
  assert.match(reply.text, /can’t currently rank the entire ASX/i);
  assert.equal(reply.presentationMode, "limited_evidence");
});

test("mixed ASX ranking requests still compose supported price evidence", async () => {
  let composed = false;
  const reply = await runSimpleChatAdapter(
    {
      message: "How is Apple doing, and rank the ASX today?",
      history: [],
    },
    {
      now: NOW,
      extractPlan: async () => ({
        prices: [["AAPL", "2026-08-12"]],
        news: [],
        rankings: [["ASX", "2026-08-12"]],
      }),
      retrieveMarket: async () => [packet("AAPL")],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async () => emptyFocused(),
      composeAnswer: async ({ market, rankings, rankingOutcomes }) => {
        composed = true;
        assert.equal(market.length, 1);
        assert.equal(rankings.length, 0);
        assert.equal(rankingOutcomes[0]?.status, "unsupported");
        return "Apple evidence is available. StockSage cannot rank the full ASX.";
      },
    }
  );

  assert.equal(composed, true);
  assert.equal(reply.dataStatus, "limited");
  assert.equal(reply.live, true);
});

test("an unspecified ranking market defaults to US", async () => {
  let retrieved = false;
  const reply = await runSimpleChatAdapter(
    { message: "What were the top and bottom performers today?", history: [] },
    {
      now: NOW,
      extractPlan: async () => ({
        prices: [],
        news: [],
        rankings: [["UNSPECIFIED", "2026-08-12"]],
      }),
      retrieveRankingOutcomes: async (requests) => {
        retrieved = true;
        assert.equal(requests[0]?.market, "US");
        assert.equal(requests[0]?.endDate, "2026-08-12");
        return [
          {
            request: requests[0],
            status: "available",
            alternatives: ["compare_named_securities"],
            evidence: availableUsRanking(),
          },
        ];
      },
      composeAnswer: async ({ rankingOutcomes }) => {
        assert.equal(rankingOutcomes[0]?.status, "available");
        assert.equal(rankingOutcomes[0]?.request.market, "US");
        return "Here are the top and bottom US performers.";
      },
    }
  );

  assert.equal(retrieved, true);
  assert.match(reply.text, /US performers/i);
  assert.equal(reply.presentationMode, "comparison");
});

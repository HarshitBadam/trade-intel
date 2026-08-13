import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { LlmRequestError } from "../../src/lib/llm";
import type { ChatRequest } from "../../src/lib/stocksage/types";
import {
  deterministicRankingMarket,
  deterministicRankingMarkets,
  hasMarketWideRankingIntent,
  isUnambiguousMarketWideRankingTurn,
} from "../../src/lib/stocksage/simple/context";
import { extractEvidencePlan } from "../../src/lib/stocksage/simple/extraction";

const NOW = new Date("2026-08-12T22:00:00.000Z");
const TODAY = "2026-08-12";

function auConversation(message: string): ChatRequest {
  return {
    message,
    history: [
      { role: "user", text: "How is CBA doing?" },
      {
        role: "ai",
        text: "Commonwealth Bank (CBA) is trading on the ASX and is up 1.8% today.",
      },
    ],
    state: {
      version: 1,
      revision: 2,
      entities: [],
      explicitEntitySet: [],
      criteria: [],
      jurisdiction: "Australia",
    },
  };
}

test("reproduces the YTD top-10 production failure: AU context recovers a malformed ranking tuple", async () => {
  const request = auConversation(
    "What have been the top 10 best and worst performers this year YTD."
  );
  let attempts = 0;
  const plan = await extractEvidencePlan(request, NOW, async () => {
    attempts += 1;
    return { prices: [], news: [], rankings: [["AU", TODAY, 10]] };
  });
  assert.equal(attempts, 1);
  assert.deepEqual(plan.rankings, [["ASX", TODAY]]);
  assert.deepEqual(plan.prices, []);
  assert.deepEqual(plan.news, []);
});

test("deterministically seeds an ASX ranking from AU jurisdiction when the ranking lane is unsalvageable", async () => {
  const request = auConversation(
    "What have been the top 10 best and worst performers this year YTD."
  );
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [],
    news: [],
    rankings: "not an array",
  }));
  assert.deepEqual(plan.rankings, [["ASX", TODAY]]);
});

test("defaults to US when no explicit market or AU context is established", async () => {
  const request: ChatRequest = {
    message: "What have been the top 10 best and worst performers this year YTD.",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [],
    news: [],
    rankings: "broken",
  }));
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
});

test("an explicit current-message market overrides established AU jurisdiction", async () => {
  const request = auConversation("Top 10 US gainers and losers today");
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [],
    news: [],
    rankings: "broken",
  }));
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
});

test("malformed dual-market extraction preserves US and ASX in request order", async () => {
  const request: ChatRequest = {
    message: "Show top 5 US and ASX performers today",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [],
    news: [],
    rankings: "broken",
  }));
  assert.deepEqual(plan.rankings, [
    ["US", TODAY],
    ["ASX", TODAY],
  ]);
});

test("dual-market salvage restores a missing market without discarding a valid one", async () => {
  const request: ChatRequest = {
    message: "Show top 5 ASX and US performers today",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [],
    news: [],
    rankings: [
      ["US", TODAY],
      ["EU", TODAY],
    ],
  }));
  assert.deepEqual(plan.rankings, [
    ["ASX", TODAY],
    ["US", TODAY],
  ]);
});

test("dual-market transport recovery preserves both explicit markets", async () => {
  const request: ChatRequest = {
    message: "Show top 5 US and ASX performers today",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => {
    throw new LlmRequestError("network down");
  });
  assert.deepEqual(plan.rankings, [
    ["US", TODAY],
    ["ASX", TODAY],
  ]);
});

test("extraction salvages bounded price and news lanes and coerces ranking aliases", async () => {
  const request: ChatRequest = {
    message:
      "How is Apple doing, and what are the top gainers and losers this year YTD?",
    history: [],
  };
  const malformed = {
    prices: [
      ["AAPL", "2026-08-12"],
      [123, "2026-08-12"],
    ],
    news: ["Apple earnings report", "", "x".repeat(600)],
    rankings: [{ market: "usa", date: "ytd" }],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => malformed);
  assert.deepEqual(plan.prices, [["AAPL", "2026-08-12"]]);
  assert.deepEqual(plan.news, ["Apple earnings report"]);
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
});

test("malformed mixed-intent output fails instead of silently dropping price evidence", async () => {
  const request: ChatRequest = {
    message: "How is Apple doing, and what are today's top gainers?",
    history: [],
  };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => ({
      prices: [["AAPL", "not-a-date"]],
      news: [],
      rankings: "broken",
    })),
    /mixed evidence could not be safely salvaged/
  );
});

test("mixed-intent recovery preserves valid price evidence while repairing rankings", async () => {
  const request: ChatRequest = {
    message: "How is Apple doing, and what are today's top gainers?",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [["AAPL", TODAY]],
    news: [],
    rankings: "broken",
  }));
  assert.deepEqual(plan.prices, [["AAPL", TODAY]]);
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
});

test("valid canonical extraction output is returned unchanged", async () => {
  const canonical = {
    prices: [["AAPL", "2026-08-12"]] as [string, string][],
    news: [] as string[],
    rankings: [] as [string, string][],
  };
  const plan = await extractEvidencePlan(
    { message: "How is Apple doing?", history: [] },
    NOW,
    async () => canonical
  );
  assert.deepEqual(plan, canonical);
});

test("invalid non-ranking output still fails rather than being silently reclassified", async () => {
  const request: ChatRequest = { message: "How is Apple doing?", history: [] };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => ({
      prices: [],
      news: [],
      rankings: [["EU", TODAY]],
    })),
    /no salvageable evidence/
  );
});

test("hasMarketWideRankingIntent recognizes canonical no-count ranking phrases", () => {
  assert.equal(hasMarketWideRankingIntent("top and bottom performers"), true);
  assert.equal(hasMarketWideRankingIntent("top performers today"), true);
  assert.equal(hasMarketWideRankingIntent("bottom performers this week"), true);
  assert.equal(hasMarketWideRankingIntent("this is the top of the range"), false);
  assert.equal(hasMarketWideRankingIntent("bottom line is strong"), false);
});

test("malformed extraction with 'top and bottom performers' (no digit) seeds a ranking", async () => {
  const request: ChatRequest = {
    message: "What are the top and bottom performers today?",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => ({
    prices: [],
    news: [],
    rankings: "broken",
  }));
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
});

test("transport failure for 'top and bottom performers' (no digit) recovers deterministically", async () => {
  const request: ChatRequest = {
    message: "What are the top and bottom performers today?",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => {
    throw new LlmRequestError("rate limited", { status: 429 });
  });
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
  assert.deepEqual(plan.prices, []);
});

test("falls back deterministically when the LLM transport fails for an unambiguous ranking turn", async () => {
  const request: ChatRequest = {
    message: "Show me today's top gainers and losers.",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => {
    throw new LlmRequestError("network down");
  });
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
  assert.deepEqual(plan.prices, []);
});

test("rethrows a transport failure for a non-ranking turn even when the error type is recoverable", async () => {
  const request: ChatRequest = { message: "How is Apple doing?", history: [] };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => {
      throw new LlmRequestError("network down");
    }),
    /network down/
  );
});

test("mixed price-and-ranking transport failure rethrows instead of dropping the price intent", async () => {
  const request: ChatRequest = {
    message: "How is Apple doing, and what are today's top 10 gainers?",
    history: [],
  };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => {
      throw new LlmRequestError("network down");
    }),
    /network down/
  );
});

test("mixed price-word-and-ranking transport failure rethrows instead of dropping the price intent", async () => {
  const request: ChatRequest = {
    message: "Apple price and today's top gainers",
    history: [],
  };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => {
      throw new LlmRequestError("network down");
    }),
    /network down/
  );
});

test("mixed ticker-and-ranking transport failure rethrows instead of dropping the named-security lane", async () => {
  const request: ChatRequest = {
    message: "AAPL and today's top gainers",
    history: [],
  };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => {
      throw new LlmRequestError("network down");
    }),
    /network down/
  );
});

test("pure 'top 10 best and worst performers YTD' transport failure still recovers deterministically", async () => {
  const request: ChatRequest = {
    message: "What have been the top 10 best and worst performers this year YTD.",
    history: [],
  };
  const plan = await extractEvidencePlan(request, NOW, async () => {
    throw new LlmRequestError("network down");
  });
  assert.deepEqual(plan.rankings, [["US", TODAY]]);
  assert.deepEqual(plan.prices, []);
});

test("an unknown programming error from the JSON call is rethrown, not masked as provider recovery", async () => {
  const request: ChatRequest = {
    message: "Show me today's top gainers and losers.",
    history: [],
  };
  await assert.rejects(
    extractEvidencePlan(request, NOW, async () => {
      throw new TypeError("cannot read properties of undefined");
    }),
    /cannot read properties of undefined/
  );
});

test("deterministicRankingMarket resolves a pronoun 'us' to AU context instead of the US market", () => {
  const request = auConversation("walk us through today's top gainers");
  assert.equal(deterministicRankingMarket(request), "ASX");
});

test("deterministicRankingMarket still recognizes structural US market mentions", () => {
  const request: ChatRequest = {
    message: "walk me through today's top US gainers",
    history: [],
  };
  assert.equal(deterministicRankingMarket(request), "US");
});

test("deterministicRankingMarkets preserves explicit multi-market order", () => {
  assert.deepEqual(
    deterministicRankingMarkets({
      message: "Top US and ASX performers",
      history: [],
    }),
    ["US", "ASX"]
  );
  assert.deepEqual(
    deterministicRankingMarkets({
      message: "Top ASX and US performers",
      history: [],
    }),
    ["ASX", "US"]
  );
});

test("isUnambiguousMarketWideRankingTurn rejects mixed price/ticker phrasing but allows pure ranking pairs", () => {
  assert.equal(
    isUnambiguousMarketWideRankingTurn(
      "What have been the top 10 best and worst performers this year YTD."
    ),
    true
  );
  assert.equal(
    isUnambiguousMarketWideRankingTurn("What are the top and bottom performers today?"),
    true
  );
  assert.equal(
    isUnambiguousMarketWideRankingTurn("top US and ASX performers today"),
    true
  );
  assert.equal(
    isUnambiguousMarketWideRankingTurn("Apple price and today's top gainers"),
    false
  );
  assert.equal(
    isUnambiguousMarketWideRankingTurn("AAPL and today's top gainers"),
    false
  );
  assert.equal(
    isUnambiguousMarketWideRankingTurn(
      "How is Apple doing, and what are today's top 10 gainers?"
    ),
    false
  );
});

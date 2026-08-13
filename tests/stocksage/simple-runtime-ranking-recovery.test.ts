import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { RANKING_RESULT_LIMIT } from "../../src/lib/market-data/market-rankings";
import { LlmRequestError } from "../../src/lib/llm";
import { resolveTemporalContext } from "../../src/lib/stocksage/temporal";
import type { ChatRequest } from "../../src/lib/stocksage/types";
import type { RankingRequest } from "../../src/lib/stocksage/simple/contracts";
import { refineRankingRequests } from "../../src/lib/stocksage/simple/ranking";

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

test("malformed ranking refinement JSON falls back to deterministic derivation", async () => {
  const request: ChatRequest = {
    message: "Top 10 US performers this year",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [{ market: "US" }],
  }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].limit, RANKING_RESULT_LIMIT);
  assert.equal(requests[0].requestedLimit, 10);
});

test("provider failure and YTD phrasing fall back to correct trading-session dates with the requested count preserved", async () => {
  const request: ChatRequest = {
    message: "Top 10 US performers this year YTD",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => {
    throw new LlmRequestError("provider exhausted", { status: 503 });
  });
  const expected = resolveTemporalContext({
    message: request.message,
    calendar: "US",
    now: NOW,
  });
  assert.equal(expected.status, "resolved");
  const interval = expected.intervals[expected.intervals.length - 1];
  assert.equal(requests[0].market, "US");
  assert.equal(requests[0].startDate, interval.startSession);
  assert.equal(requests[0].endDate, interval.endSession);
  assert.equal(requests[0].limit, RANKING_RESULT_LIMIT);
  assert.equal(requests[0].requestedLimit, 10);
});

test("valid parsed refinement with model limit 5 still preserves a user-requested count of 10", async () => {
  const request: ChatRequest = {
    message: "Top 10 best and worst US performers today",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [
      { market: "US", startDate: TODAY, endDate: TODAY, sector: null, limit: 5 },
    ],
  }));
  assert.equal(requests[0].limit, RANKING_RESULT_LIMIT);
  assert.equal(requests[0].requestedLimit, 10);
});

test("accepts a model-provided limit above five and clamps retrieval while preserving the requested count", async () => {
  const request: ChatRequest = {
    message: "Top 10 best and worst US performers today",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [
      { market: "US", startDate: TODAY, endDate: TODAY, sector: null, limit: 10 },
    ],
  }));
  assert.equal(requests[0].limit, RANKING_RESULT_LIMIT);
  assert.equal(requests[0].requestedLimit, 10);
});

test("a valid model limit is used as-is when the user gave no explicit count", async () => {
  const request: ChatRequest = { message: "Top US performers today", history: [] };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [
      { market: "US", startDate: TODAY, endDate: TODAY, sector: null, limit: 3 },
    ],
  }));
  assert.equal(requests[0].limit, 3);
  assert.equal(requests[0].requestedLimit, undefined);
});

test("a validly empty refinement uses deterministic derivation, preserving YTD dates and requested count", async () => {
  const request = auConversation("Top 10 performers this year YTD");
  const seed: RankingRequest[] = [["UNSPECIFIED", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [],
  }));
  const expected = resolveTemporalContext({
    message: request.message,
    calendar: "AU",
    now: NOW,
  });
  assert.equal(expected.status, "resolved");
  const interval = expected.intervals[expected.intervals.length - 1];
  assert.equal(requests[0].market, "ASX");
  assert.equal(requests[0].startDate, interval.startSession);
  assert.equal(requests[0].endDate, interval.endSession);
  assert.equal(requests[0].limit, RANKING_RESULT_LIMIT);
  assert.equal(requests[0].requestedLimit, 10);
});

test("a valid parsed UNSPECIFIED market honors established AU context instead of defaulting to US", async () => {
  const request = auConversation("What are today's top performers?");
  const seed: RankingRequest[] = [["UNSPECIFIED", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [
      { market: "UNSPECIFIED", startDate: TODAY, endDate: TODAY, sector: null, limit: 5 },
    ],
  }));
  assert.equal(requests[0].market, "ASX");
});

test("deterministic ranking fallback preserves explicit sector intent instead of substituting the whole market", async () => {
  const request: ChatRequest = {
    message: "What were the top 5 tech sector performers today?",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => {
    throw new LlmRequestError("provider exhausted", { status: 503 });
  });
  assert.equal(requests[0].sector, "tech");
});

test("an unknown programming error from ranking refinement JSON call is rethrown", async () => {
  const request: ChatRequest = {
    message: "Top 10 US performers this year",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  await assert.rejects(
    refineRankingRequests(request, seed, NOW, async () => {
      throw new TypeError("boom");
    }),
    /boom/
  );
});

test("multiple parsed requests preserve each market's own requested count instead of one whole-message max", async () => {
  const request: ChatRequest = {
    message: "top 3 US and top 10 ASX",
    history: [],
  };
  const seed: RankingRequest[] = [
    ["US", TODAY],
    ["ASX", TODAY],
  ];
  const requests = await refineRankingRequests(request, seed, NOW, async () => ({
    requests: [
      { market: "US", startDate: TODAY, endDate: TODAY, sector: null, limit: 3 },
      { market: "ASX", startDate: TODAY, endDate: TODAY, sector: null, limit: 10 },
    ],
  }));
  const us = requests.find((r) => r.market === "US");
  const asx = requests.find((r) => r.market === "ASX");
  assert.equal(us?.limit, 3);
  assert.equal(us?.requestedLimit, undefined);
  assert.equal(asx?.limit, RANKING_RESULT_LIMIT);
  assert.equal(asx?.requestedLimit, 10);
});

test("multiple fallback requests preserve each market's requested count", async () => {
  const request: ChatRequest = {
    message: "top 3 US and top 10 ASX",
    history: [],
  };
  const seed: RankingRequest[] = [
    ["US", TODAY],
    ["ASX", TODAY],
  ];
  const requests = await refineRankingRequests(request, seed, NOW, async () => {
    throw new LlmRequestError("provider exhausted", { status: 503 });
  });
  const us = requests.find((rankingRequest) => rankingRequest.market === "US");
  const asx = requests.find((rankingRequest) => rankingRequest.market === "ASX");
  assert.equal(us?.limit, 3);
  assert.equal(us?.requestedLimit, undefined);
  assert.equal(asx?.limit, RANKING_RESULT_LIMIT);
  assert.equal(asx?.requestedLimit, 10);
});

test("count parsing recognizes both 'top 10'/'bottom 10' and '10 best'/'10 worst' phrasing", async () => {
  const request: ChatRequest = {
    message: "Show the 10 best and 10 worst US performers today",
    history: [],
  };
  const seed: RankingRequest[] = [["US", TODAY]];
  const requests = await refineRankingRequests(request, seed, NOW, async () => {
    throw new LlmRequestError("provider exhausted", { status: 503 });
  });
  assert.equal(requests[0].requestedLimit, 10);
  assert.equal(requests[0].limit, RANKING_RESULT_LIMIT);
});

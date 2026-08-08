import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import type { ChatQuote } from "../src/lib/market-data/types";
import {
  getYahooAsxQuotes,
  parseYahooAsxChart,
  resetYahooAsxCache,
  type YahooFetch,
} from "../src/lib/market-data/yahoo-asx";
import { resolveConversationState } from "../src/lib/stocksage/entities";
import { listingCapability } from "../src/lib/stocksage/listing-capability";
import { planEvidence } from "../src/lib/stocksage/evidence/planner";
import { retrieveMarketProxy } from "../src/lib/stocksage/evidence/market";
import {
  executeEvidencePlan,
  type RetrievalProviders,
} from "../src/lib/stocksage/evidence/retrieve";
import { buildFallbackReply } from "../src/lib/stocksage/regular-fallback";
import type { EvidenceQuery } from "../src/lib/stocksage/types";

function yahooFixture(
  symbol = "CBA.AX",
  metaOverrides: Record<string, unknown> = {},
  adjustedCloses?: unknown[],
  rawCloses?: unknown[]
): unknown {
  const first = Date.UTC(2025, 7, 1, 2) / 1000;
  const timestamp = Array.from({ length: 260 }, (_, index) => first + index * 86_400);
  const closes = timestamp.map((_, index) => 100 + index);
  return {
    chart: {
      error: null,
      result: [
        {
          meta: {
            symbol,
            currency: "AUD",
            exchangeName: "ASX",
            instrumentType: "EQUITY",
            regularMarketPrice: 360,
            regularMarketPreviousClose: 358,
            regularMarketTime: timestamp.at(-1),
            ...metaOverrides,
          },
          timestamp,
          indicators: {
            quote: [{ close: rawCloses ?? closes }],
            adjclose: [{ adjclose: adjustedCloses ?? closes }],
          },
        },
      ],
    },
  };
}

function marketQuery(tickers: string[]): EvidenceQuery {
  return {
    id: "market-asx-test",
    provider: "market_proxy",
    query: "ASX performance",
    entityIds: tickers.map((ticker) => `ticker:${ticker}`),
    tickers,
    criteria: ["performance"],
    topic: "general",
    limit: 6,
  };
}

function quote(ticker: string): ChatQuote {
  return {
    ticker,
    price: 100,
    asOf: "2026-07-27",
    dayPct: 1,
    fewDaysPct: 2,
    weekPct: 3,
    monthPct: 4,
    yearPct: 5,
  };
}

test("Yahoo chart payload produces native AUD ASX quote windows", () => {
  const parsed = parseYahooAsxChart("CBA", "CBA.AX", yahooFixture());
  assert.ok(parsed);
  assert.equal(parsed.ticker, "CBA");
  assert.equal(parsed.instrumentSymbol, "CBA.AX");
  assert.equal(parsed.venue, "ASX");
  assert.equal(parsed.currency, "AUD");
  assert.equal(parsed.price, 360);
  assert.ok(Math.abs(parsed.dayPct - ((360 - 358) / 358) * 100) < 0.0001);
  assert.notEqual(parsed.weekPct, null);
  assert.notEqual(parsed.monthPct, null);
  assert.notEqual(parsed.yearPct, null);
  assert.equal(parsed.proxySymbol, undefined);
  assert.match(parsed.sourceNote ?? "", /delayed ASX data/);
});

test("Yahoo parser ties the logical ticker to an ASX equity response", () => {
  assert.equal(parseYahooAsxChart("CBA", "NAB.AX", yahooFixture("NAB.AX")), null);
  assert.equal(
    parseYahooAsxChart(
      "CBA",
      "CBA.AX",
      yahooFixture("CBA.AX", { exchangeName: "NYSE" })
    ),
    null
  );
  assert.equal(
    parseYahooAsxChart(
      "CBA",
      "CBA.AX",
      yahooFixture("CBA.AX", { instrumentType: "ETF" })
    ),
    null
  );
  assert.equal(
    parseYahooAsxChart(
      "CBA",
      "CBA.AX",
      yahooFixture("CBA.AX", { currency: "USD" })
    ),
    null
  );
});

test("Yahoo parser falls back to a coherent raw series when adjusted history is absent", () => {
  const adjusted = Array.from({ length: 260 }, () => null);
  const parsed = parseYahooAsxChart(
    " cba.ax ",
    "cba.ax",
    yahooFixture("CBA.AX", {}, adjusted)
  );
  assert.ok(parsed);
  assert.equal(parsed.ticker, "CBA");
  assert.notEqual(parsed.yearPct, null);
});

test("Yahoo parser never mixes a raw corporate-action close into adjusted history", () => {
  const adjusted: (number | null)[] = Array.from(
    { length: 260 },
    (_, index) => 50 + index
  );
  adjusted[7] = null;
  const raw = Array.from({ length: 260 }, (_, index) =>
    index === 7 ? 10_000 : 100 + index
  );
  const parsed = parseYahooAsxChart(
    "CBA",
    "CBA.AX",
    yahooFixture("CBA.AX", {}, adjusted, raw)
  );
  assert.ok(parsed);
  assert.notEqual(parsed.yearPct, null);
  assert.ok(
    (parsed.yearPct ?? 0) > 0,
    "a missing adjusted bar must be skipped, not replaced by an incompatible raw close"
  );
});

test("Yahoo ASX fetcher uses the public chart endpoint and fails closed", async () => {
  resetYahooAsxCache();
  const calls: string[] = [];
  const okFetch: YahooFetch = async (url, init) => {
    calls.push(url);
    assert.ok(init.signal, "the native request carries an internal timeout");
    return {
      ok: true,
      status: 200,
      json: async () => yahooFixture("MQG.AX"),
    };
  };
  const quotes = await getYahooAsxQuotes([" mqg.ax ", "MQG", "invalid!"], okFetch);
  assert.equal(quotes.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(quotes[0]?.ticker, "MQG");
  assert.equal(quotes[0]?.instrumentSymbol, "MQG.AX");
  assert.match(calls[0] ?? "", /query1\.finance\.yahoo\.com.*MQG\.AX/);
  assert.match(calls[0] ?? "", /interval=1d/);

  resetYahooAsxCache();
  const rateLimited = await getYahooAsxQuotes(["MQG"], async () => ({
    ok: false,
    status: 429,
    json: async () => {
      throw new Error("must not parse a 429 body");
    },
  }));
  assert.deepEqual(rateLimited, []);

  resetYahooAsxCache();
  const malformed = await getYahooAsxQuotes(["MQG"], async () => ({
    ok: true,
    status: 200,
    json: async () => ({ chart: { result: [{ meta: { symbol: "MSFT" } }] } }),
  }));
  assert.deepEqual(malformed, []);

  resetYahooAsxCache();
  const rejected = await getYahooAsxQuotes(["MQG"], async () => {
    throw new Error("network down");
  });
  assert.deepEqual(rejected, []);
});

test("Yahoo cache coalesces hits and evicts provider failures", async () => {
  resetYahooAsxCache();
  let calls = 0;
  const fetcher: YahooFetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient failure");
    return {
      ok: true,
      status: 200,
      json: async () => yahooFixture("CBA.AX"),
    };
  };

  assert.deepEqual(await getYahooAsxQuotes(["CBA"], fetcher), []);
  const [first, second] = await Promise.all([
    getYahooAsxQuotes(["CBA"], fetcher),
    getYahooAsxQuotes(["CBA.AX"], fetcher),
  ]);
  assert.equal(calls, 2);
  assert.equal(first[0]?.instrumentSymbol, "CBA.AX");
  assert.deepEqual(second, first);
});

test("native ASX resolution runs before ADR and Stooq fallbacks", async () => {
  let proxyCalls = 0;
  let stooqCalls = 0;
  const native = await retrieveMarketProxy(
    marketQuery(["CBA"]),
    async () => {
      proxyCalls += 1;
      return [];
    },
    async () => {
      stooqCalls += 1;
      return [];
    },
    async () => [
      {
        ...quote("CBA"),
        instrumentSymbol: "CBA.AX",
        venue: "ASX",
        currency: "AUD",
      },
    ]
  );
  assert.equal(proxyCalls, 0);
  assert.equal(stooqCalls, 0);
  assert.deepEqual(
    {
      ticker: native[0]?.ticker,
      instrumentSymbol: native[0]?.instrumentSymbol,
      venue: native[0]?.venue,
      currency: native[0]?.currency,
      proxySymbol: native[0]?.proxySymbol,
    },
    {
      ticker: "CBA",
      instrumentSymbol: "CBA.AX",
      venue: "ASX",
      currency: "AUD",
      proxySymbol: undefined,
    }
  );

  const fallback = await retrieveMarketProxy(
    marketQuery(["CBA"]),
    async (symbols) => {
      assert.deepEqual(symbols, ["CMWAY"]);
      return [quote("CMWAY")];
    },
    async () => [],
    async () => []
  );
  assert.equal(fallback[0]?.ticker, "CBA");
  assert.equal(fallback[0]?.proxySymbol, "CMWAY");
  assert.equal(fallback[0]?.proxyKind, "adr");
});

test("native ASX retrieval rejects malformed identity before using a proxy", async () => {
  let proxyCalls = 0;
  const result = await retrieveMarketProxy(
    marketQuery(["CBA"]),
    async () => {
      proxyCalls += 1;
      return [quote("CMWAY")];
    },
    async () => [],
    async () => [
      {
        ...quote("CBA"),
        instrumentSymbol: "CBA.AX",
        venue: "US",
        currency: "USD",
      },
    ]
  );
  assert.equal(proxyCalls, 1);
  assert.equal(result[0]?.ticker, "CBA");
  assert.equal(result[0]?.proxySymbol, "CMWAY");
  assert.equal(result[0]?.proxyKind, "adr");
});

test("planning selects native ASX quotes without touching US-only or refused turns", () => {
  const asx = resolveConversationState(
    "Compare MQG, CBA, NAB, ANZ and WBC this year",
    undefined,
    []
  );
  const plan = planEvidence({
    route: "comparison",
    message: "Compare MQG, CBA, NAB, ANZ and WBC this year",
    entities: asx.entities,
    state: asx.state,
  });
  const market = plan.queries.find((query) => query.provider === "market_proxy");
  assert.deepEqual(market?.tickers, ["MQG", "CBA", "NAB", "ANZ", "WBC"]);
  for (const entity of asx.entities) {
    const capability = listingCapability(entity);
    assert.equal(capability.quoteStrategy, "primary_asx");
    assert.equal(capability.numericParity, "native");
    assert.equal(capability.quoteInstrument?.currency, "AUD");
  }

  const apple = resolveConversationState("How is Apple doing?", undefined, []);
  const usPlan = planEvidence({
    route: "current_finance",
    message: "How is Apple doing?",
    entities: apple.entities,
    state: apple.state,
  });
  assert.equal(
    usPlan.queries.some((query) => query.provider === "market_proxy"),
    false
  );

  const refusedPlan = planEvidence({
    route: "refused",
    message: "Place this trade for me",
    entities: asx.entities,
    state: asx.state,
    retrievalAuthorized: false,
  });
  assert.deepEqual(refusedPlan.queries, []);
});

test("a slow ASX ticker does not discard completed peer quotes", async () => {
  const resolution = resolveConversationState(
    "Compare MQG and CBA today",
    undefined,
    []
  );
  const plan = planEvidence({
    route: "comparison",
    message: "Compare MQG and CBA today",
    entities: resolution.entities,
    state: resolution.state,
  });
  const providers: RetrievalProviders = {
    quotes: async () => [],
    marketProxy: async (query) => {
      if (query.tickers.includes("CBA")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return query.tickers.map((ticker) => ({
        ...quote(ticker),
        instrumentSymbol: `${ticker}.AX`,
        venue: "ASX" as const,
        currency: "AUD" as const,
      }));
    },
    astra: async () => [],
    tavily: async () => [],
  };
  const context = await executeEvidencePlan({
    plan,
    entities: resolution.entities,
    providers,
    ceilingMs: 30,
  });
  assert.deepEqual(
    context.quotes.map((item) => item.ticker),
    ["MQG"]
  );
});

test("fallback copy identifies native ASX figures as AUD, not an ADR proxy", () => {
  const entity = resolveConversationState("How is CBA doing?", undefined, [])
    .entities[0];
  assert.ok(entity);
  const native = {
    ...quote("CBA"),
    instrumentSymbol: "CBA.AX",
    venue: "ASX" as const,
    currency: "AUD" as const,
  };
  const reply = buildFallbackReply(
    { message: "How is CBA doing today?", history: [] },
    {
      route: "current_finance",
      reasonCode: "degraded_from_data",
      retrievalRequired: true,
      deepEligible: false,
    },
    [entity],
    {
      quotes: [native],
      fundamentals: [],
      sources: [],
      coverage: { [entity.id]: "covered" },
      plan: {
        version: 1,
        route: "current_finance",
        asOf: "2026-07-27T00:00:00.000Z",
        queries: [marketQuery(["CBA"])],
        requiredEntityIds: [],
        criteria: [],
      },
    }
  );
  assert.match(reply.text, /ASX:CBA/);
  assert.match(reply.text, /A\$100\.00/);
  assert.match(reply.text, /native ASX listing in AUD/);
  assert.doesNotMatch(reply.text, /\bADR\b|CMWAY|\$100\.00 at/);
});

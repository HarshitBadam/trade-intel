import assert from "node:assert/strict";
import test from "node:test";
import {
  chatQuoteFromDailyBars,
  getStooqQuotes,
  parseStooqDailyCsv,
  resetStooqCache,
} from "../src/lib/market-data/stooq";
import {
  hedgedEstimateClaim,
  proxyMisrepresentation,
} from "../src/lib/stocksage/regular-guards";
import { buildFallbackReply } from "../src/lib/stocksage/regular-fallback";
import { retrieveMarketProxy } from "../src/lib/stocksage/retrieve";
import { roundFiguresForDisplay } from "../src/lib/stocksage/rounding";
import type { ChatQuote } from "../src/lib/market-data/types";
import type { EvidenceQuery } from "../src/lib/stocksage/types";

const STOOQ_FIXTURE = `Date,Open,High,Low,Close,Volume
2025-12-30,98,101,97,100,1000
2025-12-31,100,102,99,101,1000
2026-01-02,101,104,100,103,1000
2026-01-05,103,106,102,105,1000
2026-01-06,105,107,104,106,1000
2026-01-07,106,109,105,108,1000
2026-01-08,108,111,107,110,1000
2026-01-09,110,113,109,112,1000`;

test("rounding sanitizer applies display precision without touching identifiers", () => {
  const input =
    "Price $178.5425, move 2.2393146%, beta 2.2393146 and P/E 30.9586× on 2026-07-15 for BRK.B. [Source](https://example.com/v1.23456?q=7.8912)";
  assert.equal(
    roundFiguresForDisplay(input),
    "Price $178.54, move 2.24%, beta 2.2 and P/E 31.0× on 2026-07-15 for BRK.B. [Source](https://example.com/v1.23456?q=7.8912)"
  );
  assert.equal(roundFiguresForDisplay("$211.86 and +2.31%"), "$211.86 and +2.31%");
  assert.equal(roundFiguresForDisplay("1,234.5678 shares"), "1,234.57 shares");
});

test("Stooq CSV fixture produces honest end-of-day quote windows", async () => {
  const bars = parseStooqDailyCsv(`${STOOQ_FIXTURE}\ninvalid,row`);
  assert.equal(bars.length, 8);
  const quote = chatQuoteFromDailyBars("IXIC", bars);
  assert.ok(quote);
  assert.equal(quote.eod, true);
  assert.equal(quote.asOf, "2026-01-09");
  assert.equal(quote.price, 112);
  assert.ok(Math.abs(quote.dayPct - 1.8181818) < 0.001);
  assert.ok(Math.abs((quote.ytdPct ?? 0) - 10.891089) < 0.001);

  resetStooqCache();
  const fetched = await getStooqQuotes(
    [{ ticker: "IXIC", symbol: "^ndq" }],
    async (symbol) => {
      assert.equal(symbol, "^ndq");
      return STOOQ_FIXTURE;
    }
  );
  assert.equal(fetched[0]?.ticker, "IXIC");
  assert.equal(fetched[0]?.eod, true);

  resetStooqCache();
  const rejectedHtml = await getStooqQuotes(
    [{ ticker: "IXIC", symbol: "^ndq" }],
    async () => "<html><script>challenge()</script></html>"
  );
  assert.deepEqual(rejectedHtml, []);
});

function proxyQuery(tickers: string[]): EvidenceQuery {
  return {
    id: "market-proxy-test",
    provider: "market_proxy",
    query: "compare market performance",
    entityIds: tickers.map((ticker) => `ticker:${ticker}`),
    tickers,
    criteria: ["performance"],
    topic: "general",
    limit: 6,
  };
}

function quote(ticker: string, ytdPct = 12.5): ChatQuote {
  return {
    ticker,
    price: 100,
    asOf: "2026-07-15",
    dayPct: 1,
    fewDaysPct: 2,
    weekPct: 3,
    monthPct: 4,
    yearPct: 5,
    ytdPct,
  };
}

test("market proxy fallback prefers Alpaca candidates then Stooq", async () => {
  const calls: string[][] = [];
  let stooqCalls = 0;
  const qqq = await retrieveMarketProxy(
    proxyQuery(["IXIC"]),
    async (symbols) => {
      calls.push(symbols);
      return symbols.includes("QQQ") ? [quote("QQQ")] : [];
    },
    async () => {
      stooqCalls += 1;
      return [quote("IXIC")];
    }
  );
  assert.deepEqual(calls, [["ONEQ"], ["QQQ"]]);
  assert.equal(stooqCalls, 0);
  assert.equal(qqq[0]?.ticker, "IXIC");
  assert.equal(qqq[0]?.proxySymbol, "QQQ");
  assert.match(qqq[0]?.sourceNote ?? "", /not the Nasdaq Composite/i);

  const direct = await retrieveMarketProxy(
    proxyQuery(["GSPC"]),
    async () => [],
    async (pairs) => {
      stooqCalls += 1;
      assert.deepEqual(pairs, [{ ticker: "GSPC", symbol: "^spx" }]);
      return [{ ...quote("GSPC"), eod: true }];
    }
  );
  assert.equal(direct[0]?.proxySymbol, undefined);
  assert.equal(direct[0]?.isIndex, true);
  assert.equal(direct[0]?.eod, true);
});

test("fallback labels ETF returns without representing them as index returns", () => {
  const entity = {
    id: "ticker:IXIC",
    name: "Nasdaq Composite",
    query: "Nasdaq Composite",
    ticker: "IXIC",
    market: "index" as const,
  };
  const proxy = {
    ...quote("IXIC"),
    proxySymbol: "ONEQ",
    proxyKind: "etf" as const,
    sourceNote:
      "ONEQ ETF proxy for the Nasdaq Composite; these are ONEQ returns, not Nasdaq Composite index returns",
  };
  const reply = buildFallbackReply(
    { message: "How has IXIC done this year?", history: [] },
    {
      route: "current_finance",
      reasonCode: "degraded_from_data",
      retrievalRequired: true,
      deepEligible: false,
    },
    [entity],
    {
      quotes: [proxy],
      fundamentals: [],
      sources: [],
      coverage: {},
      plan: {
        version: 1,
        route: "current_finance",
        asOf: "2026-07-16T00:00:00.000Z",
        queries: [proxyQuery(["IXIC"])],
        requiredEntityIds: [],
        criteria: [],
      },
    }
  );
  assert.match(reply.text, /\*\*ONEQ\*\*/);
  assert.match(reply.text, /ETF proxy requested for IXIC/);
  assert.match(reply.text, /not Nasdaq Composite index returns/);
  assert.doesNotMatch(reply.text, /\*\*IXIC\*\* — .*\+12\.50%/);
  assert.match(
    proxyMisrepresentation(
      "The Nasdaq Composite is up 12.5% YTD.",
      [entity],
      [proxy]
    ) ?? "",
    /ONEQ/
  );
  assert.equal(
    proxyMisrepresentation(
      "ONEQ, an ETF proxy for the Nasdaq Composite, is up 12.5% YTD; that is ONEQ's return, not the index return.",
      [entity],
      [proxy]
    ),
    null
  );
  const asxEntity = {
    id: "ticker:AXJO",
    name: "All Ordinaries",
    query: "All Ordinaries ASX",
    ticker: "AXJO",
    market: "index" as const,
  };
  const ewa = {
    ...quote("AXJO"),
    proxySymbol: "EWA",
    proxyKind: "etf" as const,
    sourceNote:
      "EWA ETF proxy for broad Australian equities; these are EWA returns",
  };
  assert.match(
    proxyMisrepresentation(
      "The ASX, through the EWA ETF proxy, is up 0.42% today.",
      [asxEntity],
      [ewa]
    ) ?? "",
    /ASX/
  );
  assert.equal(
    proxyMisrepresentation(
      "EWA, a US-listed ETF proxy for broad Australian equities rather than the ASX itself, is up 0.42% today.",
      [asxEntity],
      [ewa]
    ),
    null
  );
});

test("hedged estimate guard rejects unsupported performance guesses only", () => {
  const corpus = "IXIC YTD +13.71%; latest session +1.25%.";
  assert.match(
    hedgedEstimateClaim(
      "The Nasdaq has been known to be up around 12-15% YTD — a rough estimate.",
      corpus
    ) ?? "",
    /Nasdaq/
  );
  assert.equal(
    hedgedEstimateClaim("The Nasdaq is up roughly 13.71% YTD.", corpus),
    null
  );
  assert.equal(
    hedgedEstimateClaim("Revenue is estimated at 12% of sales.", corpus),
    null
  );
});

import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  chatQuoteFromDailyBars,
  getStooqQuotes,
  parseStooqDailyCsv,
  resetStooqCache,
} from "../src/lib/market-data/stooq";
import {
  firstPersonVerificationLimitation,
  hedgedEstimateClaim,
  investmentDirectionClaim,
  proxyMisrepresentation,
  uncitedResearchClaimUnits,
} from "../src/lib/stocksage/regular-guards";
import { buildFallbackReply } from "../src/lib/stocksage/regular-fallback";
import { retrieveMarketProxy } from "../src/lib/stocksage/evidence/market";
import { roundFiguresForDisplay } from "../src/lib/stocksage/rounding";
import type { ChatQuote } from "../src/lib/market-data/types";
import type { EvidenceQuery, EvidenceSource } from "../src/lib/stocksage/types";
import {
  resolveTemporalContext,
  temporalIntervalKey,
  type TemporalInterval,
} from "../src/lib/stocksage/temporal";

const STOOQ_FIXTURE = `Date,Open,High,Low,Close,Volume
2025-12-30,98,101,97,100,1000
2025-12-31,100,102,99,101,1000
2026-01-02,101,104,100,103,1000
2026-01-05,103,106,102,105,1000
2026-01-06,105,107,104,106,1000
2026-01-07,106,109,105,108,1000
2026-01-08,108,111,107,110,1000
2026-01-09,110,113,109,112,1000`;

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

function withReturns(
  value: ChatQuote,
  intervals: readonly TemporalInterval[],
  returns: readonly number[]
): ChatQuote {
  return {
    ...value,
    intervalMetrics: Object.fromEntries(
      intervals.map((interval, index) => [
        temporalIntervalKey(interval),
        {
          intervalKey: temporalIntervalKey(interval),
          startSession: interval.startSession,
          endSession: interval.endSession,
          firstSession: interval.startSession,
          lastSession: interval.endSession,
          price: value.price,
          returnPct: returns[index],
        },
      ])
    ),
  };
}

test("proxy comparison preserves instruments and requested horizons", () => {
  const entities = [
    {
      id: "ticker:TSLA",
      name: "Tesla",
      query: "Tesla",
      ticker: "TSLA",
      market: "us" as const,
    },
    {
      id: "ticker:IXIC",
      name: "Nasdaq Composite",
      query: "Nasdaq Composite",
      ticker: "IXIC",
      market: "index" as const,
    },
  ];
  const now = new Date("2026-07-16T20:00:00.000Z");
  const ytdResolution = resolveTemporalContext({
    message: "Compare Tesla with IXIC this year.",
    calendar: "US",
    now,
  });
  const multiResolution = resolveTemporalContext({
    message: "Compare this week, month to date, and trailing month.",
    calendar: "US",
    now,
  });
  assert.equal(ytdResolution.status, "resolved");
  assert.equal(multiResolution.status, "resolved");
  if (
    ytdResolution.status !== "resolved" ||
    multiResolution.status !== "resolved"
  ) {
    return;
  }
  const allIntervals = [
    ...ytdResolution.intervals,
    ...multiResolution.intervals,
  ];
  const quotes: ChatQuote[] = [
    withReturns({
      ...quote("TSLA", -15),
      weekPct: -6,
      mtdPct: -9,
      monthPct: -5,
    }, allIntervals, [-15, -6, -9, -5]),
    withReturns({
      ...quote("IXIC", 10),
      proxySymbol: "ONEQ",
      proxyKind: "etf",
      weekPct: -2,
      mtdPct: -3,
      monthPct: -4,
    }, allIntervals, [10, -2, -3, -4]),
  ];
  const basePlan = {
    version: 1 as const,
    route: "comparison" as const,
    asOf: "2026-07-16",
    queries: [proxyQuery(["TSLA", "IXIC"])],
    requiredEntityIds: [],
    criteria: [],
  };
  const ytdContext = {
    quotes,
    fundamentals: [],
    sources: [],
    coverage: {},
    plan: {
      ...basePlan,
      intervals: ytdResolution.intervals,
    },
  };
  const ytd = buildFallbackReply(
    { message: "Compare Tesla with IXIC this year.", history: [] },
    {
      route: "comparison",
      reasonCode: "test",
      retrievalRequired: true,
      deepEligible: false,
    },
    entities,
    ytdContext
  ).text;
  assert.match(ytd, /ONEQ \(Nasdaq Composite ETF proxy\).*\$100\.00.*this year \+10\.00%/);
  assert.doesNotMatch(ytd, /\*\*IXIC\*\* — \$100\.00/);
  assert.match(ytd, /ONEQ .* outperformed TSLA .* over this year/i);
  assert.doesNotMatch(ytd, /latest session/i);

  const multi = buildFallbackReply(
    {
      message: "Compare this week, month to date, and trailing month.",
      history: [],
    },
    {
      route: "comparison",
      reasonCode: "test",
      retrievalRequired: true,
      deepEligible: false,
    },
    entities,
    {
      ...ytdContext,
      plan: {
        ...basePlan,
        intervals: multiResolution.intervals,
      },
    }
  ).text;
  assert.match(multi, /over this week/i);
  assert.match(multi, /over month to date/i);
  assert.match(multi, /over trailing month/i);
  assert.doesNotMatch(multi, /over latest session/i);
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

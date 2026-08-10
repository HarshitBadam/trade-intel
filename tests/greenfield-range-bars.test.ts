import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryRangeBarCache,
  chunkRangeBarRequest,
  exchangeSessions,
  expectedRegularSessionBarCount,
  getBarsForRange,
  rangeCacheKey,
  rangeCacheTtlSeconds,
  routeBarProviders,
  sessionRangeToBounds,
  type OhlcvBar,
  type RangeBarRequest,
} from "../src/lib/market-data/range-bars";
import { createProvenance } from "../src/lib/market-data/provenance";

const US_REQUEST: RangeBarRequest = {
  ticker: "NVDA",
  venue: "US",
  calendar: "US",
  granularity: "1Day",
  startSession: "2019-03-01",
  endSession: "2020-06-30",
  adjusted: true,
};

function dailyBar(session: string, close = 100): OhlcvBar {
  return {
    timestamp: `${session}T21:00:00.000Z`,
    session,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1_000,
  };
}

function intradayBars(
  session: string,
  granularity: "1Min" | "15Min",
  count: number
): OhlcvBar[] {
  const intervalMinutes = granularity === "1Min" ? 1 : 15;
  const open = Date.parse(`${session}T14:30:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index / 100;
    return {
      timestamp: new Date(open + index * intervalMinutes * 60_000).toISOString(),
      session,
      open: close - 0.1,
      high: close + 0.1,
      low: close - 0.2,
      close,
      volume: 100,
    };
  });
}

test("range identity includes every semantically relevant field and historical TTL", () => {
  const key = rangeCacheKey(US_REQUEST);
  assert.match(key, /NVDA/);
  assert.match(key, /2019-03-01:2020-06-30/);
  assert.match(key, /1Day/);
  assert.match(key, /:adj$/);
  assert.notEqual(
    key,
    rangeCacheKey({ ...US_REQUEST, startSession: "2019-03-04" })
  );
  assert.notEqual(key, rangeCacheKey({ ...US_REQUEST, adjusted: false }));
  assert.notEqual(key, rangeCacheKey({ ...US_REQUEST, calendar: "AU" }));
  assert.equal(
    rangeCacheTtlSeconds(US_REQUEST, new Date("2026-08-09T00:00:00.000Z")),
    86_400
  );
  assert.equal(
    rangeCacheTtlSeconds(
      {
        ...US_REQUEST,
        granularity: "1Min",
        startSession: "2026-08-07",
        endSession: "2026-08-07",
      },
      new Date("2026-08-07T18:00:00.000Z")
    ),
    120
  );
});

test("calendar bounds honor exchange timezone/DST and sessions exclude holidays", () => {
  const us = sessionRangeToBounds({
    calendar: "US",
    granularity: "1Day",
    startSession: "2026-01-05",
    endSession: "2026-01-05",
  });
  assert.equal(us.fromISO, "2026-01-05T05:00:00.000Z");
  assert.equal(us.toISO, "2026-01-06T05:00:00.000Z");

  const au = sessionRangeToBounds({
    calendar: "AU",
    granularity: "1Day",
    startSession: "2026-01-05",
    endSession: "2026-01-05",
  });
  assert.equal(au.fromISO, "2026-01-04T13:00:00.000Z");
  assert.equal(au.toISO, "2026-01-05T13:00:00.000Z");
  assert.deepEqual(exchangeSessions("2026-01-01", "2026-01-05", "US"), [
    "2026-01-02",
    "2026-01-05",
  ]);
});

test("routing is venue-aware and arbitrary old ranges are passed through unchanged", async () => {
  assert.deepEqual(routeBarProviders(US_REQUEST), [
    "yahoo",
    "polygon",
    "alpaca",
  ]);
  assert.deepEqual(
    routeBarProviders({ ...US_REQUEST, adjusted: false }),
    ["alpaca", "polygon", "yahoo"]
  );
  assert.deepEqual(
    routeBarProviders({
      ...US_REQUEST,
      ticker: "CBA",
      venue: "ASX",
      calendar: "AU",
    }),
    ["yahoo"]
  );
  assert.deepEqual(
    routeBarProviders({ ...US_REQUEST, ticker: "GSPC", venue: "INDEX" }),
    ["stooq", "yahoo"]
  );

  let observed: RangeBarRequest | undefined;
  const expected = exchangeSessions(
    US_REQUEST.startSession,
    US_REQUEST.endSession,
    "US"
  );
  const series = await getBarsForRange(US_REQUEST, {
    providers: {
      alpaca: async (request) => {
        observed = request;
        return {
          bars: expected.map((session, index) => dailyBar(session, 100 + index)),
          provenance: createProvenance({
            provider: "fixture",
            fetchedAt: "2026-08-09T00:00:00.000Z",
            adjustment: "split+dividend",
          }),
        };
      },
    },
    availability: { alpaca: true, polygon: false, yahoo: false },
  });
  assert.equal(observed?.startSession, "2019-03-01");
  assert.equal(observed?.endSession, "2020-06-30");
  assert.equal(series.status, "complete");
  assert.equal(series.bars.length, expected.length);
  assert.equal(series.provenance?.coverageStart, "2019-03-01");
  assert.equal(series.provenance?.coverageEnd, "2020-06-30");
});

test("missing sessions are explicit partial coverage and provider failure is unavailable", async () => {
  const request: RangeBarRequest = {
    ...US_REQUEST,
    startSession: "2026-01-05",
    endSession: "2026-01-07",
  };
  const partial = await getBarsForRange(request, {
    providers: {
      alpaca: async () => ({
        bars: [dailyBar("2026-01-05"), dailyBar("2026-01-07")],
      }),
    },
    availability: { alpaca: true, polygon: false, yahoo: false },
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.reason, "missing_sessions");
  assert.deepEqual(partial.missingSessions, ["2026-01-06"]);

  const unavailable = await getBarsForRange(request, {
    providers: {
      alpaca: async () => {
        throw new Error("fixture outage");
      },
      polygon: async () => ({ bars: [] }),
    },
    availability: { alpaca: true, polygon: true, yahoo: false },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.attemptedProviders, ["polygon", "alpaca"]);
});

test("intraday completeness requires every regular-session interval", async () => {
  assert.equal(expectedRegularSessionBarCount("US", "1Min"), 390);
  assert.equal(expectedRegularSessionBarCount("US", "15Min"), 26);

  const truncated = await getBarsForRange(
    {
      ...US_REQUEST,
      granularity: "1Min",
      startSession: "2026-01-05",
      endSession: "2026-01-05",
    },
    {
      providers: {
        alpaca: async () => ({
          bars: intradayBars("2026-01-05", "1Min", 389),
        }),
      },
      availability: { alpaca: true, polygon: false, yahoo: false },
    }
  );
  assert.equal(truncated.status, "partial");
  assert.equal(truncated.reason, "missing_bars");
  assert.deepEqual(truncated.missingSessions, []);
  assert.equal(truncated.expectedBars, 390);
  assert.equal(truncated.missingBars, 1);
  assert.deepEqual(truncated.sessionCoverage, [
    {
      session: "2026-01-05",
      expectedBars: 390,
      coveredBars: 389,
      missingBars: 1,
      complete: false,
    },
  ]);

  const complete = await getBarsForRange(
    {
      ...US_REQUEST,
      granularity: "15Min",
      startSession: "2026-01-05",
      endSession: "2026-01-05",
    },
    {
      providers: {
        alpaca: async () => ({
          bars: intradayBars("2026-01-05", "15Min", 26),
        }),
      },
      availability: { alpaca: true, polygon: false, yahoo: false },
    }
  );
  assert.equal(complete.status, "complete");
  assert.equal(complete.missingBars, 0);
});

test("production intraday adapters chunk sessions and preserve Polygon pagination", async () => {
  const request: RangeBarRequest = {
    ...US_REQUEST,
    granularity: "1Min",
    startSession: "2026-01-05",
    endSession: "2026-01-13",
    adjusted: false,
  };
  assert.deepEqual(
    chunkRangeBarRequest(request).map((chunk) => [
      chunk.startSession,
      chunk.endSession,
    ]),
    [
      ["2026-01-05", "2026-01-09"],
      ["2026-01-12", "2026-01-13"],
    ]
  );

  const calls: string[] = [];
  let page = 0;
  const result = await getBarsForRange(request, {
    availability: { alpaca: false, polygon: true },
    polygonFetch: async (url) => {
      calls.push(url);
      const isNextPage = url.startsWith("https://fixture.test/page/");
      if (!isNextPage) page += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [],
          next_url: isNextPage
            ? undefined
            : `https://fixture.test/page/${page}`,
        }),
      };
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(calls.length, 4);
  assert.match(calls[0] ?? "", /2026-01-05\/2026-01-09/);
  assert.equal(calls[1], "https://fixture.test/page/1");
  assert.match(calls[2] ?? "", /2026-01-12\/2026-01-13/);
  assert.equal(calls[3], "https://fixture.test/page/2");
});

test("dynamic Yahoo and Stooq defaults carry the exact requested dates", async () => {
  const timestamps = [
    Date.parse("2026-01-05T05:00:00.000Z") / 1_000,
    Date.parse("2026-01-06T05:00:00.000Z") / 1_000,
    Date.parse("2026-01-07T05:00:00.000Z") / 1_000,
  ];
  let yahooUrl = "";
  const asx = await getBarsForRange(
    {
      ticker: "CBA",
      venue: "ASX",
      calendar: "AU",
      granularity: "1Day",
      startSession: "2026-01-05",
      endSession: "2026-01-07",
      adjusted: true,
    },
    {
      yahooFetch: async (url) => {
        yahooUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            chart: {
              error: null,
              result: [
                {
                  meta: {
                    symbol: "CBA.AX",
                    currency: "AUD",
                    exchangeName: "ASX",
                  },
                  timestamp: timestamps,
                  indicators: {
                    quote: [
                      {
                        open: [99, 100, 101],
                        high: [101, 102, 103],
                        low: [98, 99, 100],
                        close: [100, 101, 102],
                        volume: [10, 20, 30],
                      },
                    ],
                    adjclose: [{ adjclose: [50, 50.5, 51] }],
                  },
                },
              ],
            },
          }),
        };
      },
    }
  );
  assert.equal(asx.status, "complete");
  assert.equal(asx.bars[0]?.close, 50);
  const parsedYahoo = new URL(yahooUrl);
  assert.equal(parsedYahoo.searchParams.get("period1"), "1767531600");
  assert.equal(parsedYahoo.searchParams.get("period2"), "1767790800");

  let stooqUrl = "";
  const index = await getBarsForRange(
    {
      ticker: "GSPC",
      venue: "INDEX",
      calendar: "US",
      granularity: "1Day",
      startSession: "1999-01-04",
      endSession: "1999-01-05",
      adjusted: false,
    },
    {
      stooqFetch: async (url) => {
        stooqUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () =>
            "Date,Open,High,Low,Close,Volume\n1999-01-04,1,2,1,2,10\n1999-01-05,2,3,2,3,20",
        };
      },
    }
  );
  assert.equal(index.status, "complete");
  const parsedStooq = new URL(stooqUrl);
  assert.equal(parsedStooq.searchParams.get("d1"), "19990104");
  assert.equal(parsedStooq.searchParams.get("d2"), "19990105");
  assert.equal(parsedStooq.searchParams.get("s"), "^spx");
});

test("memory cache is exact-range scoped", async () => {
  const cache = new InMemoryRangeBarCache();
  let calls = 0;
  const dependencies = {
    cache,
    providers: {
      alpaca: async () => {
        calls += 1;
        return {
          bars: [
            dailyBar("2026-01-05", 100),
            dailyBar("2026-01-06", 101),
          ],
        };
      },
    },
    availability: { alpaca: true, polygon: false, yahoo: false },
  } as const;
  const request: RangeBarRequest = {
    ...US_REQUEST,
    startSession: "2026-01-05",
    endSession: "2026-01-06",
  };
  await getBarsForRange(request, dependencies);
  await getBarsForRange(request, dependencies);
  assert.equal(calls, 1);
  await getBarsForRange({ ...request, endSession: "2026-01-07" }, dependencies);
  assert.equal(calls, 2);
});

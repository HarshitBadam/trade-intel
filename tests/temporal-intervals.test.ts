import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSession,
  defaultInterval,
  describeInterval,
  isTradingSession,
  latestCompletedSession,
  mergeContrastIntervals,
  parseIntervals,
  previousSession,
  resolveTemporalContext,
  temporalIntervalKey,
  translateInterval,
} from "../src/lib/stocksage/temporal";
import { buildChatQuote } from "../src/lib/market-data/quote-metrics";

test("AU and US disagree about 'today' across the dateline", () => {
  // 10:30 Monday in Sydney is still 20:30 Sunday in New York.
  const now = new Date("2026-07-27T00:30:00.000Z");
  assert.equal(currentSession("AU", now), "2026-07-27");
  assert.equal(currentSession("US", now), "2026-07-24");
});

test("a session only counts once its local open has passed", () => {
  // 09:00 in New York, half an hour before the bell.
  const preOpen = new Date("2026-07-27T13:00:00.000Z");
  assert.equal(currentSession("US", preOpen), "2026-07-24");
  // 09:45, after the bell.
  const postOpen = new Date("2026-07-27T13:45:00.000Z");
  assert.equal(currentSession("US", postOpen), "2026-07-27");
});

test("closing-price evidence excludes an in-progress daily session", () => {
  const beforeAsxClose = new Date("2026-08-11T05:52:00.000Z");
  assert.equal(latestCompletedSession("AU", beforeAsxClose), "2026-08-10");
  const afterAsxClose = new Date("2026-08-11T06:05:00.000Z");
  assert.equal(latestCompletedSession("AU", afterAsxClose), "2026-08-11");
  const beforeUsOpen = new Date("2026-08-11T08:00:00.000Z");
  assert.equal(latestCompletedSession("US", beforeUsOpen), "2026-08-10");
});

test("weekends roll back to the prior trading session", () => {
  const saturday = new Date("2026-07-25T18:00:00.000Z");
  assert.equal(currentSession("US", saturday), "2026-07-24");
  assert.equal(previousSession("2026-07-27", "US"), "2026-07-24");
});

test("each calendar closes on its own holidays", () => {
  // Good Friday 2026 closes both markets.
  assert.equal(isTradingSession("2026-04-03", "US"), false);
  assert.equal(isTradingSession("2026-04-03", "AU"), false);
  // Easter Monday is an ASX holiday only.
  assert.equal(isTradingSession("2026-04-06", "AU"), false);
  assert.equal(isTradingSession("2026-04-06", "US"), true);
  // 4 July 2026 falls on a Saturday, so the US observes it on the Friday.
  assert.equal(isTradingSession("2026-07-03", "US"), false);
  assert.equal(isTradingSession("2026-07-03", "AU"), true);
  // Australia Day is an ASX holiday only.
  assert.equal(isTradingSession("2026-01-26", "AU"), false);
  assert.equal(isTradingSession("2026-01-26", "US"), true);
});

test("month to date and trailing month are different windows", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  const [mtd] = parseIntervals({ message: "how is it MTD?", calendar: "US", now });
  const [trailing] = parseIntervals({
    message: "how is it over the last month?",
    calendar: "US",
    now,
  });
  assert.equal(mtd.kind, "to_date");
  assert.equal(mtd.startSession, "2026-07-01");
  assert.equal(trailing.kind, "trailing");
  assert.equal(trailing.startSession, "2026-06-26");
  assert.notEqual(mtd.startSession, trailing.startSession);
  assert.equal(mtd.endSession, trailing.endSession);
});

test("multiple windows in one question keep their spoken order", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  const intervals = parseIntervals({
    message:
      "How did Nvidia close this week? How is that different from last week, last month, and last year?",
    calendar: "US",
    now,
  });
  assert.deepEqual(
    intervals.map((interval) => interval.label),
    ["this week", "last week", "last month", "last year"]
  );
  for (const interval of intervals) {
    assert.equal(interval.source, "explicit");
    assert.ok(interval.startSession <= interval.endSession);
  }
});

test("a contrast follow-up keeps the active period beside the new period", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  const previous = [defaultInterval("US", now)];
  const parsed = parseIntervals({
    message: "contrast that with last month",
    calendar: "US",
    now,
  });
  const merged = mergeContrastIntervals({
    message: "contrast that with last month",
    previous,
    parsed,
  });
  assert.deepEqual(
    merged.map((interval) => interval.label),
    ["today", "last month"]
  );
  assert.equal(merged[0].source, "inherited");
  assert.equal(merged[1].source, "explicit");
});

test("an unspoken window defaults to the current session, not a raw string", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  assert.deepEqual(parseIntervals({ message: "how is Apple?", calendar: "US", now }), []);
  const fallback = defaultInterval("US", now);
  assert.equal(fallback.source, "default");
  assert.equal(fallback.label, "today");
  assert.equal(fallback.startSession, fallback.endSession);
});

test("the same words resolve to different sessions in each market", () => {
  const now = new Date("2026-07-06T20:00:00.000Z");
  const [us] = parseIntervals({ message: "what moved yesterday?", calendar: "US", now });
  const [au] = parseIntervals({ message: "what moved yesterday?", calendar: "AU", now });
  // 3 July is closed in the US for Independence Day but open on the ASX.
  assert.equal(us.endSession, "2026-07-02");
  assert.equal(au.endSession, "2026-07-03");

  const translated = translateInterval(us, "AU", now);
  assert.equal(translated.calendar, "AU");
  assert.equal(translated.label, us.label);
  assert.equal(translated.endSession, au.endSession);
});

test("intervals describe their venue so answers cannot blur the two", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  const [au] = parseIntervals({ message: "how did it do today?", calendar: "AU", now });
  assert.match(describeInterval(au), /ASX session 2026-07-2\d/);
  const [us] = parseIntervals({ message: "how did it do last week?", calendar: "US", now });
  assert.match(describeInterval(us), /US sessions 2026-07-\d\d to 2026-07-\d\d/);
});

test("explicit date ranges survive as bounded trading sessions", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  const [range] = parseIntervals({
    message: "compare them between 2026-07-04 and 2026-07-12",
    calendar: "US",
    now,
  });
  assert.equal(range.kind, "range");
  // Both endpoints land on weekends and snap inward to real sessions.
  assert.equal(range.startSession, "2026-07-06");
  assert.equal(range.endSession, "2026-07-10");
});

test("point-in-time relative offsets resolve to one prior trading session", () => {
  const now = new Date("2026-08-09T20:00:00.000Z");
  const resolution = resolveTemporalContext({
    message: "How was this like a month ago?",
    calendar: "US",
    now,
  });
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;
  assert.deepEqual(resolution.intervals, [
    {
      version: 1,
      label: "a month ago",
      kind: "session",
      calendar: "US",
      startSession: "2026-07-07",
      endSession: "2026-07-07",
      source: "explicit",
      raw: "a month ago",
    },
  ]);
});

test("slash dates are strict day-first dates and invalid dates are rejected", () => {
  const now = new Date("2026-08-09T20:00:00.000Z");
  const valid = resolveTemporalContext({
    message: "How was SpaceX on 07/07/2026?",
    calendar: "US",
    now,
  });
  assert.equal(valid.status, "resolved");
  if (valid.status === "resolved") {
    assert.equal(valid.intervals[0].label, "07/07/2026");
    assert.equal(valid.intervals[0].startSession, "2026-07-07");
    assert.equal(valid.intervals[0].endSession, "2026-07-07");
  }

  const invalid = resolveTemporalContext({
    message: "How was SpaceX on 31/02/2026?",
    calendar: "US",
    now,
  });
  assert.equal(invalid.status, "invalid");
  if (invalid.status === "invalid") {
    assert.equal(invalid.raw, "31/02/2026");
    assert.match(invalid.clarification, /valid date/i);
  }
});

test("overlapping month aliases compile exactly once", () => {
  const now = new Date("2026-08-09T20:00:00.000Z");
  assert.deepEqual(
    parseIntervals({
      message: "How did it perform over the last month?",
      calendar: "US",
      now,
    }).map((value) => value.label),
    ["trailing month"]
  );
  assert.deepEqual(
    parseIntervals({
      message: "Compare last month with over the last month",
      calendar: "US",
      now,
    }).map((value) => value.label),
    ["last month", "trailing month"]
  );
});

test("quote metrics distinguish calendar periods from trailing windows", () => {
  const quote = buildChatQuote(
    [
      { date: "2026-06-30T04:00:00.000Z", value: 100 },
      { date: "2026-07-01T04:00:00.000Z", value: 110 },
      { date: "2026-07-31T04:00:00.000Z", value: 120 },
      { date: "2026-08-03T04:00:00.000Z", value: 119 },
      { date: "2026-08-07T04:00:00.000Z", value: 121 },
    ],
    { ticker: "TEST", price: 121, dayPct: 1.68 }
  );
  assert.ok(quote);
  assert.equal(quote.asOf, "2026-08-07");
  assert.equal(quote.lastMonthPct, 20);
  assert.equal(quote.lastMonthStart, "2026-07-01");
  assert.equal(quote.lastMonthEnd, "2026-07-31");
  assert.ok(Math.abs((quote.wtdPct ?? 0) - 0.8333333333) < 0.001);
});

test("normalized point intervals produce the historical close and session move", () => {
  const resolution = resolveTemporalContext({
    message: "How was it on 07/07/2026?",
    calendar: "US",
    now: new Date("2026-08-09T20:00:00.000Z"),
  });
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;
  const [requested] = resolution.intervals;
  const quote = buildChatQuote(
    [
      { date: "2026-07-06", value: 100 },
      { date: "2026-07-07", value: 110 },
      { date: "2026-08-07", value: 120 },
    ],
    { ticker: "TEST", price: 120, dayPct: 9.09 },
    resolution.intervals
  );
  assert.ok(quote);
  assert.deepEqual(quote.intervalMetrics?.[temporalIntervalKey(requested)], {
    intervalKey: "US:2026-07-07:2026-07-07",
    startSession: "2026-07-07",
    endSession: "2026-07-07",
    firstSession: "2026-07-07",
    lastSession: "2026-07-07",
    price: 110,
    returnPct: 10,
    baselineSession: "2026-07-06",
  });
});

test("holiday snapping selects the prior real candle", () => {
  const resolution = resolveTemporalContext({
    message: "How was it on 04/07/2026?",
    calendar: "US",
    now: new Date("2026-08-09T20:00:00.000Z"),
  });
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;
  const [requested] = resolution.intervals;
  assert.equal(requested.endSession, "2026-07-02");
  const quote = buildChatQuote(
    [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-02", value: 105 },
      { date: "2026-07-06", value: 106 },
    ],
    { ticker: "TEST", price: 106, dayPct: 0.95 },
    resolution.intervals
  );
  assert.ok(quote);
  assert.equal(
    quote.intervalMetrics?.[temporalIntervalKey(requested)]?.price,
    105
  );
});

test("bounded ranges use the candle before the range as their baseline", () => {
  const resolution = resolveTemporalContext({
    message: "How did it do last month?",
    calendar: "US",
    now: new Date("2026-08-09T20:00:00.000Z"),
  });
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;
  const [requested] = resolution.intervals;
  const quote = buildChatQuote(
    [
      { date: "2026-06-30", value: 100 },
      { date: "2026-07-01", value: 110 },
      { date: "2026-07-31", value: 120 },
      { date: "2026-08-07", value: 125 },
    ],
    { ticker: "TEST", price: 125, dayPct: 4.17 },
    resolution.intervals
  );
  assert.ok(quote);
  const metric = quote.intervalMetrics?.[temporalIntervalKey(requested)];
  assert.equal(metric?.price, 120);
  assert.equal(metric?.returnPct, 20);
  assert.equal(metric?.baselineSession, "2026-06-30");
});

test("missing historical candles never become latest-session metrics", () => {
  const resolution = resolveTemporalContext({
    message: "How was it on 07/07/2025?",
    calendar: "US",
    now: new Date("2026-08-09T20:00:00.000Z"),
  });
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;
  const [requested] = resolution.intervals;
  const quote = buildChatQuote(
    [
      { date: "2026-08-06", value: 100 },
      { date: "2026-08-07", value: 110 },
    ],
    { ticker: "TEST", price: 110, dayPct: 10 },
    resolution.intervals
  );
  assert.ok(quote);
  assert.equal(
    quote.intervalMetrics?.[temporalIntervalKey(requested)],
    undefined
  );
  assert.equal(quote.price, 110);
});

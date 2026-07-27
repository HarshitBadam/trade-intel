import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSession,
  defaultInterval,
  describeInterval,
  isTradingSession,
  parseIntervals,
  previousSession,
  translateInterval,
} from "../src/lib/stocksage/temporal";

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

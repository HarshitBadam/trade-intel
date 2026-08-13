import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCloseToCloseMovers,
  getMarketRanking,
  resolveUsRankingSession,
  summarizeMarketMovers,
  type RankedMover,
} from "../../src/lib/market-data/market-rankings";

test("computes adjusted close-to-close returns instead of open-to-close moves", () => {
  const rows = computeCloseToCloseMovers(
    [
      { T: "AAPL", c: 110, v: 1_000_000 },
      { T: "MSFT", c: 90, v: 1_000_000 },
    ],
    [
      { T: "AAPL", c: 100, v: 900_000 },
      { T: "MSFT", c: 100, v: 900_000 },
    ]
  );

  assert.equal(rows.find((row) => row.ticker === "AAPL")?.returnPct, 10);
  assert.equal(rows.find((row) => row.ticker === "MSFT")?.returnPct, -10);
  assert.equal(rows.find((row) => row.ticker === "AAPL")?.previousClose, 100);
});

test("filters rows below the market-mover liquidity floor", () => {
  const rows = computeCloseToCloseMovers(
    [
      { T: "AAPL", c: 110, v: 9_999 },
    ],
    [
      { T: "AAPL", c: 100, v: 9_999 },
    ]
  );
  assert.deepEqual(rows, []);
});

test("caps compact ranking evidence at five rows per side", () => {
  const rows: RankedMover[] = Array.from({ length: 14 }, (_, index) => ({
    ticker: `T${index}`,
    close: 100 + index,
    previousClose: 100,
    change: index - 7,
    returnPct: index - 7,
  }));
  const compact = summarizeMarketMovers(rows);
  assert.equal(compact.gainers.length, 5);
  assert.equal(compact.losers.length, 5);
  assert.deepEqual(
    compact.gainers.map((row) => row.returnPct),
    [6, 5, 4, 3, 2]
  );
  assert.deepEqual(
    compact.losers.map((row) => row.returnPct),
    [-7, -6, -5, -4, -3]
  );
});

test("resolves active, completed, and non-trading US ranking sessions", () => {
  assert.deepEqual(
    resolveUsRankingSession(
      "2026-08-12",
      new Date("2026-08-12T15:00:00.000Z")
    ),
    { session: "2026-08-12", mode: "live_session" }
  );
  assert.deepEqual(
    resolveUsRankingSession(
      "2026-08-12",
      new Date("2026-08-12T22:00:00.000Z")
    ),
    { session: "2026-08-12", mode: "completed_session" }
  );
  assert.deepEqual(
    resolveUsRankingSession(
      "2026-08-15",
      new Date("2026-08-17T12:00:00.000Z")
    ),
    { session: "2026-08-14", mode: "completed_session" }
  );
});

test("returns deterministic ASX-wide unsupported evidence without providers", async () => {
  const packet = await getMarketRanking(
    "ASX",
    "2026-08-12",
    new Date("2026-08-12T06:30:00.000Z")
  );
  assert.equal(packet.status, "unsupported");
  assert.equal(packet.reason, "asx_market_wide_unsupported");
  assert.deepEqual(packet.gainers, []);
  assert.deepEqual(packet.losers, []);
});

test("does not present an Alpaca subset as a complete historical US ranking", async () => {
  const packet = await getMarketRanking(
    "US",
    "2026-08-11",
    new Date("2026-08-12T22:00:00.000Z")
  );
  assert.equal(packet.status, "unavailable");
  assert.equal(packet.reason, "provider_not_configured");
  assert.equal(packet.mode, "completed_session");
});

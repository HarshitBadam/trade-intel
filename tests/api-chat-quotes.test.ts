import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import {
  getChatQuotes,
  resetChatCandleCache,
  type ChatCandleFetcher,
} from "../src/lib/market-data/api-chat";

function candles(ticker: string, price: number) {
  return {
    symbol: ticker,
    company_name: ticker,
    stock_price: price,
    percent_change: 1,
    chart_data: [
      { date: "2026-08-06T04:00:00.000Z", value: price - 1 },
      { date: "2026-08-07T04:00:00.000Z", value: price },
    ],
    source: "Polygon" as const,
  };
}

test("chat quote cache preserves partial successes and evicts failures", async () => {
  resetChatCandleCache();
  const calls = new Map<string, number>();
  const fetcher: ChatCandleFetcher = async (ticker) => {
    const count = (calls.get(ticker) ?? 0) + 1;
    calls.set(ticker, count);
    if (ticker === "SPCX" && count === 1) {
      throw new Error("transient quote failure");
    }
    return candles(ticker, ticker === "TSLA" ? 320 : 80) as never;
  };

  const cold = await getChatQuotes(["TSLA", "SPCX"], fetcher);
  assert.deepEqual(cold.map((quote) => quote.ticker), ["TSLA"]);

  const [firstWarm, secondWarm] = await Promise.all([
    getChatQuotes(["TSLA", "SPCX"], fetcher),
    getChatQuotes(["TSLA", "SPCX"], fetcher),
  ]);
  assert.deepEqual(
    firstWarm.map((quote) => quote.ticker),
    ["TSLA", "SPCX"]
  );
  assert.deepEqual(secondWarm, firstWarm);
  assert.equal(calls.get("TSLA"), 1);
  assert.equal(calls.get("SPCX"), 2);
});

test("chat quote collection returns an empty result instead of throwing", async () => {
  resetChatCandleCache();
  const unavailable: ChatCandleFetcher = async () => {
    throw new Error("all providers unavailable");
  };
  assert.deepEqual(await getChatQuotes(["TSLA", "SPCX"], unavailable), []);
});

import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceQuery } from "../../src/lib/stocksage/types";
import {
  searchTavily,
  searchTavilyDetailed,
} from "../../src/lib/stocksage/tavily";

const QUERY: EvidenceQuery = {
  id: "focused-news-test",
  provider: "tavily",
  query: "Macquarie whistleblower allegations",
  entityIds: ["ticker:MQG"],
  tickers: ["MQG"],
  criteria: ["specific requested story"],
  topic: "news",
  limit: 6,
};

test("detailed Tavily search distinguishes provider unavailability", async () => {
  const result = await searchTavilyDetailed(QUERY);
  assert.deepEqual(result, {
    status: "unavailable",
    evidence: [],
    reason: "not_configured",
  });
});

test("Tavily evidence wrapper preserves its fail-open contract", async () => {
  assert.deepEqual(await searchTavily(QUERY), []);
});

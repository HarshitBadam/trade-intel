import assert from "node:assert/strict";
import test from "node:test";

import { resolveText } from "../src/lib/stocksage/entity-resolution";
import { enrichListingEntities } from "../src/lib/stocksage/listing-status";
import type { FinanceEntity } from "../src/lib/stocksage/types";

test("SpaceX resolves to its current public listing", () => {
  const [spaceX] = resolveText("How is SpaceX doing?");
  assert.equal(spaceX.ticker, "SPCX");
  assert.equal(spaceX.market, "us");
  assert.equal(spaceX.private, undefined);
});

test("a stale private entity can be upgraded through the listing lookup", async () => {
  const stale: FinanceEntity = {
    id: "name:futureco",
    name: "FutureCo",
    query: "FutureCo financial news",
    market: "web",
    private: true,
  };
  const [upgraded] = await enrichListingEntities([stale], async () => [
    { ticker: "FUTR", name: "FutureCo Inc. Common Stock" },
  ]);
  assert.equal(upgraded.ticker, "FUTR");
  assert.equal(upgraded.market, "us");
  assert.equal(upgraded.private, undefined);
});

test("listing enrichment does not turn an unrelated search hit into a stock", async () => {
  const privateFirm: FinanceEntity = {
    id: "name:deloitte",
    name: "Deloitte",
    query: "Deloitte financial performance",
    market: "web",
    private: true,
  };
  const [unchanged] = await enrichListingEntities([privateFirm], async () => [
    { ticker: "DLO", name: "DLocal Limited" },
  ]);
  assert.deepEqual(unchanged, privateFirm);
});

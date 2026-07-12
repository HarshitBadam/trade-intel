import assert from "node:assert/strict";
import test from "node:test";
import { unsupportedFigures } from "../src/lib/stocksage/figures";

const CORPUS = `TSLA — $312.48 as of 2026-07-10. Latest session +1.92% | 1 week -3.10% | 1 month +6.75% | 1 year +12.40%
MQG — trailing P/E 18.2, TTM revenue growth +4.90% YoY, beta 1.31
[S1] reuters.com (2026-07-09) — Tesla deliveries beat estimates
Tesla delivered 512,000 vehicles in the quarter, ahead of the 495,000 consensus. Revenue reached US$29.6 billion.`;

test("passes figures that appear in the evidence", () => {
  assert.deepEqual(
    unsupportedFigures(
      "Tesla closed at **$312.48**, up +1.92% on the day and +12.40% over the year. Deliveries hit 512,000 against a 495,000 consensus [S1], with revenue of $29.6 billion.",
      CORPUS
    ),
    []
  );
});

test("passes rounded and rescaled restatements", () => {
  assert.deepEqual(
    unsupportedFigures(
      "It's around $312 now, up about 2% today and roughly 12% on the year. Revenue was close to $30 billion.",
      CORPUS
    ),
    []
  );
});

test("flags figures that appear nowhere in the evidence", () => {
  const flagged = unsupportedFigures(
    "CBA's CET1 ratio is **11.8%** and its market cap is A$143.6 billion, while the stock trades at $312.48.",
    CORPUS
  );
  assert.deepEqual(flagged, ["11.8%", "A$143.6 billion"]);
});

test("ignores bare integers, years, and dates", () => {
  assert.deepEqual(
    unsupportedFigures(
      "The big 4 banks have led since 2020; over 3 sessions and 12 months the picture differs, and a top 10 list follows.",
      CORPUS
    ),
    []
  );
});

test("allows figures the user supplied themselves", () => {
  assert.deepEqual(
    unsupportedFigures(
      "You mentioned $500; the stock is at $312.48, so it sits well below that.",
      `${CORPUS}\nis it worth $500 yet?`
    ),
    []
  );
});

test("flags invented percentages in evidence-free replies", () => {
  assert.deepEqual(unsupportedFigures("The S&P is up 1.2% today.", "sup boss"), [
    "1.2%",
  ]);
  assert.deepEqual(unsupportedFigures("Hey! What are you looking into?", "sup"), []);
});

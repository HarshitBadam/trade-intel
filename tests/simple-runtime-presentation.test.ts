import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMarkdownLayout } from "../src/components/chat/ChatMessage";
import {
  monthlyClosesFromBars,
  polishSimpleAnswerStyle,
  quarterlyPerformanceFromBars,
} from "../src/lib/stocksage/simple-runtime";
import { resolveText } from "../src/lib/stocksage/entity-resolution";
import type { OhlcvBar } from "../src/lib/market-data/range-bars";

test("normalizes collapsed generated Markdown table rows", () => {
  const collapsed =
    "| Firm | Detail | |------|--------| | Deloitte | Private | | PwC | Private |";
  assert.equal(
    normalizeMarkdownLayout(collapsed),
    [
      "| Firm | Detail |",
      "|------|--------|",
      "| Deloitte | Private |",
      "| PwC | Private |",
    ].join("\n")
  );
});

test("normalizes citation markers without rewriting prose", () => {
  assert.equal(
    polishSimpleAnswerStyle(
      "Banks – market snapshot. Tesla — supported by evidence 【yahoo】; SpaceX · carries more risk 【S1】."
    ),
    "Banks – market snapshot. Tesla — supported by evidence; SpaceX · carries more risk [S1]."
  );
});

test("preserves negative numeric signs", () => {
  assert.equal(
    polishSimpleAnswerStyle("| AAPL | –0.28% |\n| GOOG | −5.33% |"),
    "| AAPL | -0.28% |\n| GOOG | -5.33% |"
  );
});

function bar(session: string, close: number): OhlcvBar {
  return {
    timestamp: `${session}T21:00:00.000Z`,
    session,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

test("samples monthly closes and quarter coverage deterministically", () => {
  const bars = [
    bar("2026-01-05", 100),
    bar("2026-01-30", 110),
    bar("2026-02-27", 121),
    bar("2026-03-31", 133.1),
    bar("2026-04-01", 140),
    bar("2026-05-29", 147),
  ];

  assert.deepEqual(monthlyClosesFromBars(bars), [
    { month: "2026-01", session: "2026-01-30", close: 110 },
    { month: "2026-02", session: "2026-02-27", close: 121 },
    { month: "2026-03", session: "2026-03-31", close: 133.1 },
    { month: "2026-04", session: "2026-04-01", close: 140 },
    { month: "2026-05", session: "2026-05-29", close: 147 },
  ]);

  const quarters = quarterlyPerformanceFromBars(bars, "2026-05-29");
  assert.equal(quarters[0]?.quarter, "2026-Q1");
  assert.equal(quarters[0]?.status, "complete");
  assert.equal(quarters[1]?.quarter, "2026-Q2");
  assert.equal(quarters[1]?.status, "to_date");
});

test("retains useful entity aliases and market metadata", () => {
  assert.equal(
    resolveText("ASML and TSMC").every((entity) => entity.market === "us"),
    true
  );
  assert.deepEqual(
    resolveText("Sandisk and Caterpillar").map((entity) => entity.ticker),
    ["SNDK", "CAT"]
  );
  assert.deepEqual(
    resolveText("Deloitte KMPG EY PWC").map((entity) => entity.name),
    ["Deloitte", "PwC", "KPMG", "EY"]
  );
  assert.deepEqual(
    resolveText("Berkshire Hathway").map((entity) => entity.ticker),
    ["BRK.A"]
  );
});

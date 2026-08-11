import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMarkdownLayout } from "../src/components/chat/ChatMessage";
import {
  ensureDefaultPerformanceRange,
  fallbackSubjectDatePairs,
  groundPairsToDeterministicContext,
  monthlyClosesFromBars,
  polishSimpleAnswerStyle,
  quarterlyPerformanceFromBars,
  simplePublicationIssues,
  wantsGroupComparison,
  wantsMonthlySeries,
  wantsMonthlySeriesForRequest,
} from "../src/lib/stocksage/simple-runtime";
import { resolveConversationState } from "../src/lib/stocksage/conversation-entity-state";
import { resolveText } from "../src/lib/stocksage/entity-resolution";
import type { OhlcvBar } from "../src/lib/market-data/range-bars";
import type { EvidenceSource } from "../src/lib/stocksage/types";

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

test("does not replace decorative punctuation with awkward commas", () => {
  assert.equal(
    polishSimpleAnswerStyle(
      "Banks – market snapshot. Tesla — supported by evidence 【yahoo】; SpaceX · carries more risk 【S1】."
    ),
    "Banks – market snapshot. Tesla — supported by evidence; SpaceX · carries more risk [S1]."
  );
});

test("preserves en dashes used as negative numeric signs", () => {
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

test("samples monthly closes and completed versus to-date quarters deterministically", () => {
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

test("monthly requests use range boundaries and deterministic entity fallback", () => {
  const message =
    "Draw a table for ASML and TSMC at monthly granularity for the last 12 months";
  assert.equal(wantsMonthlySeries(message), true);
  assert.equal(
    wantsMonthlySeries(
      "AAPL vs Google prices, per month and per quarter for the last 12 months"
    ),
    true
  );
  assert.equal(
    wantsMonthlySeriesForRequest({
      message: "Do you get it? Aug-25 through Aug-26 for the three companies",
      history: [
        {
          role: "user",
          text: "Show their prices per month for the last 12 months",
        },
      ],
    }),
    true
  );
  assert.deepEqual(
    ensureDefaultPerformanceRange(
      [
        ["SPCX", "2026-08-11"],
        ["TSLA", "2026-08-11"],
      ],
      "How is SpaceX vs Tesla doing?"
    ),
    [
      ["SPCX", "2026-01-01"],
      ["SPCX", "2026-08-11"],
      ["TSLA", "2026-01-01"],
      ["TSLA", "2026-08-11"],
    ]
  );
  assert.equal(
    wantsGroupComparison(
      "Australian Big 4 banks vs Big Four consultancy as groups"
    ),
    true
  );
  const resolution = resolveConversationState(message, undefined, [], {
    now: new Date("2026-08-11T00:00:00.000Z"),
  });
  assert.deepEqual(
    fallbackSubjectDatePairs(resolution, "2026-08-11").map(([subject]) => subject),
    ["ASML", "ASML", "TSM", "TSM"]
  );
  assert.deepEqual(
    groundPairsToDeterministicContext(
      [
        ["ASML", "2025-07-01"],
        ["ASML", "2026-08-11"],
      ],
      resolution
    ),
    fallbackSubjectDatePairs(resolution, "2026-08-11")
  );
  assert.equal(resolveText("ASML and TSMC").every((entity) => entity.market === "us"), true);
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

test("publication integrity rejects unsupported figures and semantic contradictions", () => {
  const sources: EvidenceSource[] = [
    {
      id: "S1",
      kind: "tavily",
      title: "Current Macquarie outlook",
      outlet: "Reuters",
      url: "https://example.com/macquarie",
      excerpt: "Current earnings were stronger.",
      publishedAt: "2026-05-08",
      retrievedAt: "2026-08-11T00:00:00.000Z",
      entityIds: ["ticker:MQG"],
      criteria: [],
    },
  ];
  const corpus = JSON.stringify({
    market: [
      {
        requestedPoints: [
          { requestedDate: "2025-12-31", session: "2025-12-31", close: 100 },
          { requestedDate: "2026-08-07", session: "2026-08-07", close: 105.88 },
        ],
        returnKind: "period",
        returnPct: 5.88,
      },
    ],
    sources,
  });
  const issues = simplePublicationIssues(
    [
      "The market cap is A$71.5 billion.",
      "2026-08-10 (Wednesday) was a non-trading day.",
      "All peers posted double-digit declines, including -5.88%.",
      "That was a roughly 19-month period.",
      "From 2019 to 2021, it rose because earnings improved [S1].",
      "The two samples show a steady rise.",
      "The May 7, 2026 Reuters article reported the update [S1].",
      "Caveat: the system could not retrieve the supplied evidence.",
      "Outlook — cautiously positive; risks remain · elevated.",
      "Unsupported reference [web].",
    ].join("\n"),
    corpus,
    sources
  );
  assert.ok(issues.some((issue) => issue.startsWith("unsupported figures:")));
  assert.ok(issues.some((issue) => issue.startsWith("wrong weekday")));
  assert.ok(issues.some((issue) => issue.startsWith("incorrect double-digit")));
  assert.ok(issues.some((issue) => issue.startsWith("incorrect period length")));
  assert.ok(issues.some((issue) => issue.startsWith("source S1 postdates")));
  assert.ok(issues.includes("sparse sampled points were described as a continuous trend"));
  assert.ok(issues.some((issue) => issue.startsWith("wrong publication date")));
  assert.ok(issues.includes("system or evidence limitation language was exposed"));
  assert.ok(issues.includes("decorative punctuation was used in prose"));
  assert.ok(issues.includes("invalid citation label: web"));
  assert.ok(
    simplePublicationIssues(
      "| A | B |\n| --- | --- |\n| one |",
      corpus,
      sources
    ).includes("incomplete or malformed markdown table")
  );
});

import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMarkdownLayout } from "../src/components/chat/ChatMessage";
import {
  ensureTableSourceCitations,
  polishSimpleAnswerStyle,
} from "../src/lib/stocksage/simple-runtime";
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

test("removes disallowed decorative punctuation from simple answers", () => {
  assert.equal(
    polishSimpleAnswerStyle(
      "Banks – market snapshot. Tesla — supported by evidence 【yahoo】; SpaceX · carries more risk 【S1】."
    ),
    "Banks, market snapshot. Tesla, supported by evidence. SpaceX, carries more risk [S1]."
  );
});

test("preserves en dashes used as negative numeric signs", () => {
  assert.equal(
    polishSimpleAnswerStyle("| AAPL | –0.28% |\n| GOOG | −5.33% |"),
    "| AAPL | -0.28% |\n| GOOG | -5.33% |"
  );
});

test("adds a matching citation marker to sourced table rows", () => {
  const sources: EvidenceSource[] = [
    {
      id: "S1",
      kind: "tavily",
      title: "Bear case focuses on execution risk for robotaxi and AI ventures",
      outlet: "The Motley Fool",
      url: "https://example.com/tesla",
      excerpt: "Execution risk remains material.",
      retrievedAt: "2026-08-10T00:00:00.000Z",
      entityIds: ["ticker:TSLA"],
      criteria: [],
    },
  ];
  assert.equal(
    ensureTableSourceCitations(
      '| Tesla | "Bear case focuses on execution risk for robotaxi and AI ventures", The Motley Fool |',
      sources
    ),
    '| Tesla | "Bear case focuses on execution risk for robotaxi and AI ventures", The Motley Fool [S1] |'
  );
});

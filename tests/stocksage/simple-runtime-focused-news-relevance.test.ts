import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { filterFocusedNewsEvidence } from "../../src/lib/stocksage/simple/news";
import type {
  EvidenceSource,
  FinanceEntity,
} from "../../src/lib/stocksage/types";

const MQG: FinanceEntity = {
  id: "ticker:MQG",
  name: "Macquarie Group",
  query: "Macquarie Group",
  ticker: "MQG",
  market: "au",
};

function evidence(
  title: string,
  excerpt: string,
  score: number
): EvidenceSource {
  return {
    id: title,
    kind: "tavily",
    title,
    outlet: "example.com",
    url: `https://example.com/${encodeURIComponent(title)}`,
    excerpt,
    score,
    entityIds: [MQG.id],
    criteria: ["specific requested story"],
    retrievedAt: "2026-08-13T00:00:00.000Z",
  };
}

test("focused relevance rejects generic company results for a specific claim", () => {
  const generic = evidence(
    "Macquarie proposes takeover of Qube",
    "Macquarie Group announced a logistics acquisition.",
    0.29
  );
  assert.deepEqual(
    filterFocusedNewsEvidence(
      "Macquarie Group soulja boy incident",
      [MQG],
      [generic]
    ),
    []
  );
});

test("focused relevance keeps reporting that matches distinctive story terms", () => {
  const relevant = evidence(
    "KPMG whistle-blower allegations prompt Macquarie review",
    "The audit firm is reviewing claims involving confidential data.",
    0.31
  );
  assert.deepEqual(
    filterFocusedNewsEvidence(
      "Macquarie KPMG whistleblower allegations",
      [MQG],
      [relevant]
    ),
    [relevant]
  );
});

test("a strong provider relevance score can preserve a semantic paraphrase", () => {
  const semanticMatch = evidence(
    "Australian bank reviews unusual cultural claim",
    "The report examines the requested episode.",
    0.72
  );
  assert.deepEqual(
    filterFocusedNewsEvidence(
      "Macquarie Group unfamiliar named incident",
      [MQG],
      [semanticMatch]
    ),
    [semanticMatch]
  );
});

test("entity-only focused queries are not filtered without topic terms", () => {
  const generic = evidence(
    "Macquarie Group update",
    "A general company update.",
    0.2
  );
  assert.deepEqual(
    filterFocusedNewsEvidence("Macquarie Group news", [MQG], [generic]),
    [generic]
  );
});

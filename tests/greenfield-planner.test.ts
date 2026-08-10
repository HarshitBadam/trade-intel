import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalLedgerState } from "../src/lib/stocksage/greenfield/conversation-ledger";
import {
  DEFAULT_SEC_FACT_CONCEPTS,
  resolveMetricCapability,
} from "../src/lib/stocksage/greenfield/metric-capabilities";
import { planGreenfieldTurn } from "../src/lib/stocksage/greenfield/planner";
import type { SemanticInterpretation } from "../src/lib/stocksage/greenfield/semantic-interpreter";
import {
  SemanticTurnSchema,
  type MetricSpec,
} from "../src/lib/stocksage/greenfield/semantic-schema";
import type { FinanceEntity } from "../src/lib/stocksage/types";

const APPLE: FinanceEntity = {
  id: "ticker:AAPL",
  name: "Apple",
  query: "Apple AAPL stock financials",
  ticker: "AAPL",
  market: "us",
};

const STATE: CanonicalLedgerState = {
  topic: { id: "topic:apple", label: "Apple fundamentals" },
  intent: "metric_lookup",
  informationNeeds: [],
  entities: [APPLE],
  groups: [],
  metrics: [],
  temporal: [],
  answer: { depth: "standard", format: "prose", confidence: 0.99 },
  ambiguities: [],
  assumptions: [],
  provenance: {},
  frames: [],
  focusEntityIds: [APPLE.id],
  activeTemporalAnchors: [],
};

function interpretation(metrics: readonly MetricSpec[]): SemanticInterpretation {
  const semantic = SemanticTurnSchema.parse({
    version: 1,
    turnId: "metric-plan",
    originalText: "Show me the requested Apple metric",
    intent: { kind: "metric_lookup", confidence: 0.99 },
    informationNeeds: [
      {
        id: "fundamentals",
        kind: "fundamentals",
        question: "Requested Apple metric",
        priority: "primary",
      },
    ],
    entities: {
      mentions: [],
      inheritance: {
        mode: "none",
        entityIds: [],
        orderedPositions: [],
        confidence: 0.99,
      },
      groupCandidates: [],
      confidence: 0.99,
    },
    comparison: {
      kind: "none",
      entityMentionIds: [],
      temporalSpecIds: [],
      confidence: 0.99,
    },
    metrics,
    temporal: { inherit: "none", specs: [], confidence: 0.99 },
    answer: { depth: "standard", format: "prose", confidence: 0.99 },
    topic: { mode: "continue", confidence: 0.99 },
    ambiguities: [],
    assumptions: [],
    corrections: [],
    confidence: 0.99,
  });
  return {
    semantic,
    grounding: {
      entityMentions: [],
      inheritedEntities: [],
      groups: [],
      issues: [],
    },
    compiledTemporal: [],
    standaloneQuery: semantic.originalText,
  };
}

function plan(metrics: readonly MetricSpec[]) {
  return planGreenfieldTurn({
    interpretation: interpretation(metrics),
    state: STATE,
    calendar: "US",
    now: new Date("2026-08-10T12:00:00.000Z"),
  });
}

test("metric registry resolves direct facts and bounded derivations", () => {
  const directMetrics = [
    ["Total Revenue", "revenue"],
    ["Net income", "net_income"],
    ["Assets", "assets"],
    ["Liabilities", "liabilities"],
    ["Shareholders' equity", "equity"],
    ["Cash and cash equivalents", "cash"],
    ["Total debt", "debt"],
    ["Diluted EPS", "eps"],
  ] as const;

  for (const [name, canonicalName] of directMetrics) {
    const resolution = resolveMetricCapability({
      id: canonicalName,
      name,
      operation: "level",
    });
    assert.equal(resolution.capability, "direct");
    assert.equal(resolution.canonicalName, canonicalName);
    assert.ok(resolution.requiredConcepts.length > 0);
  }

  const ratio = resolveMetricCapability({
    id: "leverage",
    name: "Debt-to-equity ratio",
    operation: "ratio",
  });
  assert.equal(ratio.capability, "derivable");
  assert.deepEqual(
    ratio.factRequirements.map((requirement) => requirement.metric),
    ["debt", "equity"]
  );

  const growth = resolveMetricCapability({
    id: "revenue-growth",
    name: "Revenue growth",
    operation: "growth",
  });
  assert.equal(growth.capability, "derivable");
  assert.equal(growth.factRequirements[0]?.minimumObservations, 2);

  const ratioPlan = plan([
    {
      id: "leverage",
      name: "Debt-to-equity ratio",
      operation: "ratio",
      confidence: 0.99,
    },
  ]);
  const ratioFacts = ratioPlan.needs.find(
    (need) => need.kind === "company_facts"
  );
  assert.ok(ratioFacts?.kind === "company_facts");
  assert.deepEqual(ratioFacts.concepts, ratio.requiredConcepts);
});

test("planner suppresses fallback facts for an explicit unsupported metric", () => {
  const unsupportedMetric: MetricSpec = {
    id: "custom-score",
    name: "Proprietary revenue quality score",
    operation: "level",
    confidence: 0.99,
  };
  const unsupportedPlan = plan([unsupportedMetric]);

  assert.equal(unsupportedPlan.metricResolutions?.[0]?.capability, "unsupported");
  assert.equal(
    unsupportedPlan.needs.some((need) => need.kind === "company_facts"),
    false
  );

  const defaultPlan = plan([]);
  const defaultFacts = defaultPlan.needs.find(
    (need) => need.kind === "company_facts"
  );
  assert.ok(defaultFacts?.kind === "company_facts");
  assert.deepEqual(defaultFacts.concepts, DEFAULT_SEC_FACT_CONCEPTS);
});

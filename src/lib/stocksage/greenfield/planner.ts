import { currentSession, previousSession, type MarketCalendar, type TemporalInterval } from "../temporal";
import type { FinanceEntity } from "../types";
import type { CanonicalLedgerState } from "./conversation-ledger";
import type { SemanticInterpretation } from "./semantic-interpreter";

export type GreenfieldToolKind =
  | "market_data"
  | "security_master"
  | "company_facts"
  | "concept_knowledge"
  | "documents";

export type MarketDataNeed = {
  id: string;
  kind: "market_data";
  entity: FinanceEntity;
  interval: TemporalInterval;
  /** Includes the preceding session required for reproducible returns. */
  fetchStartSession: string;
  fetchEndSession: string;
};

export type SecurityMasterNeed = {
  id: string;
  kind: "security_master";
  entity: FinanceEntity;
};

export type CompanyFactsNeed = {
  id: string;
  kind: "company_facts";
  entity: FinanceEntity;
  concepts: readonly string[];
};

export type DocumentNeed = {
  id: string;
  kind: "documents";
  query: string;
  entityIds: readonly string[];
  currentAsk: boolean;
  kinds: readonly ("news" | "filing" | "transcript" | "press_release" | "research" | "web")[];
  intervals: readonly TemporalInterval[];
};

export type ConceptKnowledgeNeed = {
  id: string;
  kind: "concept_knowledge";
  labels: readonly string[];
};

export type GreenfieldInformationNeed =
  | MarketDataNeed
  | SecurityMasterNeed
  | CompanyFactsNeed
  | ConceptKnowledgeNeed
  | DocumentNeed;

export type GreenfieldExecutionPlan = {
  version: 1;
  turnId: string;
  asOf: string;
  calendar: MarketCalendar;
  standaloneQuery: string;
  entities: readonly FinanceEntity[];
  intervals: readonly TemporalInterval[];
  needs: readonly GreenfieldInformationNeed[];
  answerDepth: "brief" | "standard" | "deep";
  comparison: boolean;
  causal: boolean;
};

const MARKET_NEEDS = new Set([
  "current_state",
  "price_performance",
  "ranking",
  "comparison",
]);

const FACT_NEEDS = new Set(["fundamentals", "valuation"]);

const DOCUMENT_NEEDS = new Set([
  "risk",
  "catalyst",
  "cause",
  "source_check",
  "current_state",
]);

const CONCEPT_BY_METRIC: Readonly<Record<string, readonly string[]>> = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"],
  earnings: ["NetIncomeLoss", "EarningsPerShareDiluted"],
  profit: ["NetIncomeLoss", "OperatingIncomeLoss"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity"],
  cash: ["CashAndCashEquivalentsAtCarryingValue"],
  debt: ["LongTermDebtCurrent", "LongTermDebtNoncurrent"],
  valuation: ["EntityPublicFloat", "CommonStocksIncludingAdditionalPaidInCapital"],
};

function uniqueEntities(values: readonly FinanceEntity[]): FinanceEntity[] {
  return [...new Map(values.map((entity) => [entity.id, entity])).values()];
}

function planEntities(
  interpretation: SemanticInterpretation,
  state: CanonicalLedgerState
): FinanceEntity[] {
  const explicit = interpretation.grounding.entityMentions.flatMap((mention) =>
    mention.entity ? [mention.entity] : []
  );
  const groups = interpretation.grounding.groups.flatMap((group) =>
    group.status === "grounded" ? group.memberEntities : []
  );
  return uniqueEntities([
    ...explicit,
    ...interpretation.grounding.inheritedEntities,
    ...groups,
    ...state.entities,
  ]);
}

function planIntervals(
  interpretation: SemanticInterpretation,
  calendar: MarketCalendar,
  now: Date
): TemporalInterval[] {
  const explicit = interpretation.compiledTemporal.flatMap((item) => item.intervals);
  if (explicit.length > 0) return explicit;
  const hasTemporalIntent =
    interpretation.semantic.temporal.specs.length > 0 ||
    interpretation.semantic.temporal.inherit === "active";
  if (hasTemporalIntent) return [];
  const session = currentSession(calendar, now);
  return [
    {
      version: 1,
      label: "latest available session",
      kind: "session",
      calendar,
      startSession: session,
      endSession: session,
      source: "default",
    },
  ];
}

function factConcepts(interpretation: SemanticInterpretation): string[] {
  const requested = interpretation.semantic.metrics.flatMap((metric) => {
    const name = metric.name.toLowerCase();
    return Object.entries(CONCEPT_BY_METRIC).flatMap(([key, concepts]) =>
      name.includes(key) ? concepts : []
    );
  });
  return [
    ...new Set(
      requested.length > 0
        ? requested
        : [
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "NetIncomeLoss",
            "Assets",
            "Liabilities",
          ]
    ),
  ];
}

function requestedKinds(interpretation: SemanticInterpretation): DocumentNeed["kinds"] {
  const kinds = new Set<DocumentNeed["kinds"][number]>();
  for (const need of interpretation.semantic.informationNeeds) {
    if (need.kind === "fundamentals" || need.kind === "valuation") {
      kinds.add("filing");
      kinds.add("transcript");
    }
    if (need.kind === "cause" || need.kind === "catalyst" || need.kind === "risk") {
      kinds.add("news");
      kinds.add("press_release");
      kinds.add("filing");
      kinds.add("transcript");
    }
    if (need.kind === "source_check" || need.kind === "current_state") {
      kinds.add("news");
      kinds.add("web");
    }
  }
  if (kinds.size === 0) kinds.add("news");
  return [...kinds];
}

function isCurrentAsk(
  interpretation: SemanticInterpretation,
  intervals: readonly TemporalInterval[]
): boolean {
  if (
    interpretation.semantic.intent.kind === "causal_analysis" ||
    interpretation.semantic.intent.kind === "outlook_research"
  ) {
    return true;
  }
  return intervals.some((interval) => interval.source === "default");
}

function effectiveNeedKinds(
  interpretation: SemanticInterpretation
): Set<string> {
  const kinds = new Set(
    interpretation.semantic.informationNeeds.map((need) => need.kind)
  );
  switch (interpretation.semantic.intent.kind) {
    case "entity_snapshot":
      kinds.add("price_performance");
      break;
    case "entity_comparison":
      kinds.add("comparison");
      break;
    case "causal_analysis":
      kinds.add("price_performance");
      kinds.add("cause");
      break;
    case "outlook_research":
      kinds.add("risk");
      kinds.add("catalyst");
      break;
    case "concept_explanation":
      kinds.add("definition");
      break;
    default:
      break;
  }
  return kinds;
}

/**
 * Plans from validated semantic information needs. It never re-reads the raw
 * message with regexes and never chooses a provider based on a missing result.
 */
export function planGreenfieldTurn(args: {
  interpretation: SemanticInterpretation;
  state: CanonicalLedgerState;
  calendar: MarketCalendar;
  now: Date;
}): GreenfieldExecutionPlan {
  const { interpretation, state, calendar, now } = args;
  const entities = planEntities(interpretation, state);
  const intervals = planIntervals(interpretation, calendar, now);
  const kinds = effectiveNeedKinds(interpretation);
  const needs: GreenfieldInformationNeed[] = [];

  if (kinds.has("definition")) {
    needs.push({
      id: `concept:${interpretation.semantic.turnId}`,
      kind: "concept_knowledge",
      labels: [
        ...interpretation.semantic.metrics.map((metric) => metric.name),
        ...interpretation.semantic.informationNeeds
          .filter((need) => need.kind === "definition")
          .map((need) => need.question),
        ...(interpretation.semantic.topic.label
          ? [interpretation.semantic.topic.label]
          : []),
      ],
    });
  }

  if ([...kinds].some((kind) => MARKET_NEEDS.has(kind))) {
    const commonFetchStart = intervals
      .map((interval) =>
        previousSession(interval.startSession, interval.calendar)
      )
      .sort()[0];
    const commonFetchEnd = intervals
      .map((interval) => interval.endSession)
      .sort()
      .at(-1);
    for (const entity of entities.filter((item) => Boolean(item.ticker) && !item.private)) {
      for (const interval of intervals) {
        needs.push({
          id: `market:${entity.id}:${interval.startSession}:${interval.endSession}`,
          kind: "market_data",
          entity,
          interval,
          fetchStartSession:
            commonFetchStart ??
            previousSession(interval.startSession, interval.calendar),
          fetchEndSession: commonFetchEnd ?? interval.endSession,
        });
      }
    }
  }

  if (
    kinds.has("listing_status") ||
    kinds.has("current_state") ||
    needs.some((need) => need.kind === "market_data")
  ) {
    for (const entity of entities) {
      needs.push({
        id: `security:${entity.id}`,
        kind: "security_master",
        entity,
      });
    }
  }

  if ([...kinds].some((kind) => FACT_NEEDS.has(kind))) {
    const concepts = factConcepts(interpretation);
    for (const entity of entities.filter(
      (item) => item.market === "us" && Boolean(item.ticker) && !item.private
    )) {
      needs.push({
        id: `facts:${entity.id}`,
        kind: "company_facts",
        entity,
        concepts,
      });
    }
  }

  if (
    [...kinds].some((kind) => DOCUMENT_NEEDS.has(kind)) ||
    interpretation.semantic.intent.kind === "outlook_research" ||
    interpretation.semantic.intent.kind === "causal_analysis"
  ) {
    needs.push({
      id: `documents:${interpretation.semantic.turnId}`,
      kind: "documents",
      query: interpretation.standaloneQuery,
      entityIds: entities.map((entity) => entity.id),
      currentAsk: isCurrentAsk(interpretation, intervals),
      kinds: requestedKinds(interpretation),
      intervals,
    });
  }

  return {
    version: 1,
    turnId: interpretation.semantic.turnId,
    asOf: now.toISOString(),
    calendar,
    standaloneQuery: interpretation.standaloneQuery,
    entities,
    intervals,
    needs,
    answerDepth: interpretation.semantic.answer.depth,
    comparison: interpretation.semantic.comparison.kind !== "none",
    causal: interpretation.semantic.intent.kind === "causal_analysis",
  };
}

import { currentSession, previousSession, type MarketCalendar, type TemporalInterval } from "../temporal";
import type { FinanceEntity } from "../types";
import {
  flattenObligationNeeds,
  type AnswerObligation,
  type AnswerObligationKind,
  type AnswerObligationPublicationRole,
  type AnswerObligationRelationalMode,
  type AnswerObligationTemporalMeaning,
} from "./answer-obligations";
import type { CanonicalLedgerState } from "./conversation-ledger";
import {
  DEFAULT_SEC_FACT_CONCEPTS,
  resolveMetricCapabilities,
  type MetricCapabilityResolution,
} from "./metric-capabilities";
import type { SemanticInterpretation } from "./semantic-interpreter";
import type { InformationNeed } from "./semantic-schema";

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
  obligations: readonly AnswerObligation[];
  /** Backward-compatible union for the current monolithic executor. */
  needs: readonly GreenfieldInformationNeed[];
  /** Optional on legacy plans; populated by the v1 planner for diagnostics. */
  metricResolutions?: readonly MetricCapabilityResolution[];
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
  if (interpretation.semantic.metrics.length === 0) {
    return [...DEFAULT_SEC_FACT_CONCEPTS];
  }
  return [
    ...new Set(
      resolveMetricCapabilities(interpretation.semantic.metrics).flatMap(
        (resolution) => resolution.requiredConcepts
      )
    ),
  ];
}

function requestedKinds(
  needKinds: ReadonlySet<InformationNeed["kind"]>
): DocumentNeed["kinds"] {
  const kinds = new Set<DocumentNeed["kinds"][number]>();
  for (const needKind of needKinds) {
    if (needKind === "fundamentals" || needKind === "valuation") {
      kinds.add("filing");
      kinds.add("transcript");
    }
    if (
      needKind === "cause" ||
      needKind === "catalyst" ||
      needKind === "risk"
    ) {
      kinds.add("news");
      kinds.add("press_release");
      kinds.add("filing");
      kinds.add("transcript");
    }
    if (needKind === "source_check" || needKind === "current_state") {
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

type ObligationSourceNeed = Omit<InformationNeed, "id"> & {
  id?: string;
};

function effectiveInformationNeeds(
  interpretation: SemanticInterpretation
): ObligationSourceNeed[] {
  const needs: ObligationSourceNeed[] = [
    ...interpretation.semantic.informationNeeds,
  ];
  const hasExplicitNeeds = needs.length > 0;
  const addImplied = (
    kind: InformationNeed["kind"],
    priority: InformationNeed["priority"] = "primary"
  ) => {
    if (needs.some((need) => need.kind === kind)) return;
    needs.push({
      kind,
      question: interpretation.standaloneQuery,
      priority,
    });
  };

  switch (interpretation.semantic.intent.kind) {
    case "entity_snapshot":
      if (!hasExplicitNeeds) addImplied("price_performance");
      break;
    case "entity_comparison":
      if (!hasExplicitNeeds) addImplied("comparison");
      break;
    case "metric_lookup":
      if (!hasExplicitNeeds) addImplied("fundamentals");
      break;
    case "causal_analysis":
      addImplied("price_performance", "supporting");
      addImplied("cause");
      break;
    case "outlook_research":
      addImplied("risk");
      addImplied("catalyst");
      break;
    case "concept_explanation":
      addImplied("definition");
      break;
    default:
      break;
  }
  return needs;
}

function obligationKindFor(
  needKind: InformationNeed["kind"]
): AnswerObligationKind {
  switch (needKind) {
    case "definition":
      return "define";
    case "comparison":
    case "ranking":
      return "compare";
    case "cause":
      return "explain_cause";
    case "risk":
    case "catalyst":
      return "assess_outlook";
    case "listing_status":
      return "verify_listing";
    case "source_check":
      return "verify_source";
    default:
      return "snapshot";
  }
}

function publicationRolesFor(
  needKind: InformationNeed["kind"]
): readonly AnswerObligationPublicationRole[] {
  if (
    needKind === "current_state" ||
    needKind === "fundamentals" ||
    needKind === "valuation"
  ) {
    return ["deterministic", "narrative"];
  }
  return DOCUMENT_NEEDS.has(needKind)
    ? ["narrative"]
    : ["deterministic"];
}

function relationalModeFor(
  interpretation: SemanticInterpretation,
  kind: AnswerObligationKind,
  entities: readonly FinanceEntity[]
): AnswerObligationRelationalMode {
  const mode = interpretation.semantic.comparison.kind;
  if (mode !== "none") return mode;
  return (kind === "compare" ||
    interpretation.semantic.intent.kind === "entity_comparison") &&
    entities.length > 1
    ? "entity_vs_entity"
    : "none";
}

function entitiesForRelationalMode(
  interpretation: SemanticInterpretation,
  entities: readonly FinanceEntity[],
  mode: AnswerObligationRelationalMode
): FinanceEntity[] {
  if (mode !== "entity_vs_entity" && mode !== "entity_and_time") {
    return [...entities];
  }
  const requestedMentionIds = new Set(
    interpretation.semantic.comparison.entityMentionIds
  );
  if (requestedMentionIds.size === 0) return [...entities];
  const requestedEntities = interpretation.grounding.entityMentions.flatMap(
    (mention) =>
      requestedMentionIds.has(mention.mentionId) && mention.entity
        ? [mention.entity]
        : []
  );
  return requestedEntities.length > 0
    ? uniqueEntities(requestedEntities)
    : [...entities];
}

function intervalsForRelationalMode(
  interpretation: SemanticInterpretation,
  intervals: readonly TemporalInterval[],
  mode: AnswerObligationRelationalMode
): TemporalInterval[] {
  if (mode !== "time_vs_time" && mode !== "entity_and_time") {
    return [...intervals];
  }
  const requestedSpecIds = new Set(
    interpretation.semantic.comparison.temporalSpecIds
  );
  const scoped = interpretation.compiledTemporal
    .filter((spec) => requestedSpecIds.has(spec.id))
    .flatMap((spec) => spec.intervals);
  return scoped.length > 0 ? scoped : [...intervals];
}

function temporalMeaningFor(
  interpretation: SemanticInterpretation,
  sourceTemporalSpecIds: readonly string[]
): AnswerObligationTemporalMeaning {
  const requested = new Set(sourceTemporalSpecIds);
  const specs = interpretation.compiledTemporal.filter(
    (spec) => requested.size === 0 || requested.has(spec.id)
  );
  if (specs.some((spec) => spec.kind === "comparison")) return "contrast";
  if (specs.some((spec) => spec.kind === "range")) return "window";
  return "snapshot";
}

function documentQueryFor(
  obligation: Pick<AnswerObligation, "sourceNeedIds">,
  interpretation: SemanticInterpretation
): string {
  const sourceIds = new Set(obligation.sourceNeedIds);
  const questions = interpretation.semantic.informationNeeds
    .filter((need) => sourceIds.has(need.id))
    .map((need) => need.question);
  return questions.length > 0
    ? [...new Set(questions)].join("; ")
    : interpretation.standaloneQuery;
}

function planNeedsForObligation(
  obligation: Omit<AnswerObligation, "needs">,
  interpretation: SemanticInterpretation
): GreenfieldInformationNeed[] {
  const needs: GreenfieldInformationNeed[] = [];
  const sourceKinds = new Set(obligation.sourceNeedKinds);

  if (
    obligation.publicationRole === "deterministic" &&
    obligation.kind === "define"
  ) {
    const sourceIds = new Set(obligation.sourceNeedIds);
    needs.push({
      id: `concept:${obligation.id}`,
      kind: "concept_knowledge",
      labels: [
        ...interpretation.semantic.metrics.map((metric) => metric.name),
        ...interpretation.semantic.informationNeeds
          .filter(
            (need) =>
              need.kind === "definition" &&
              (sourceIds.size === 0 || sourceIds.has(need.id))
          )
          .map((need) => need.question),
        ...(interpretation.semantic.topic.label
          ? [interpretation.semantic.topic.label]
          : []),
      ],
    });
  }

  const needsMarketData =
    obligation.publicationRole === "deterministic" &&
    [...sourceKinds].some((kind) => MARKET_NEEDS.has(kind));
  if (needsMarketData) {
    const commonFetchStart = obligation.intervals
      .map((interval) =>
        previousSession(interval.startSession, interval.calendar)
      )
      .sort()[0];
    const commonFetchEnd = obligation.intervals
      .map((interval) => interval.endSession)
      .sort()
      .at(-1);
    for (const entity of obligation.entities.filter(
      (item) => Boolean(item.ticker) && !item.private
    )) {
      for (const interval of obligation.intervals) {
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
    obligation.publicationRole === "deterministic" &&
    (obligation.kind === "verify_listing" ||
      sourceKinds.has("current_state") ||
      needs.some((need) => need.kind === "market_data"))
  ) {
    for (const entity of obligation.entities) {
      needs.push({
        id: `security:${entity.id}`,
        kind: "security_master",
        entity,
      });
    }
  }

  if (
    obligation.publicationRole === "deterministic" &&
    [...sourceKinds].some((kind) => FACT_NEEDS.has(kind))
  ) {
    const concepts = factConcepts(interpretation);
    if (concepts.length > 0) {
      for (const entity of obligation.entities.filter(
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
  }

  if (obligation.publicationRole === "narrative") {
    needs.push({
      id: `documents:${obligation.id}`,
      kind: "documents",
      query: documentQueryFor(obligation, interpretation),
      entityIds: obligation.entities.map((entity) => entity.id),
      currentAsk: isCurrentAsk(interpretation, obligation.intervals),
      kinds: requestedKinds(sourceKinds),
      intervals: obligation.intervals,
    });
  }

  return needs;
}

type ObligationGroup = {
  kind: AnswerObligationKind;
  lane: string;
  publicationRole: AnswerObligationPublicationRole;
  sources: ObligationSourceNeed[];
};

function obligationLaneFor(
  needKind: InformationNeed["kind"],
  publicationRole: AnswerObligationPublicationRole
): string {
  if (publicationRole === "narrative") {
    if (needKind === "current_state") return "current_documents";
    if (needKind === "fundamentals" || needKind === "valuation") {
      return "facts_documents";
    }
    if (needKind === "risk" || needKind === "catalyst") {
      return "outlook_documents";
    }
    return `${needKind}_documents`;
  }
  if (needKind === "definition") return "concept";
  if (needKind === "fundamentals" || needKind === "valuation") return "facts";
  if (needKind === "listing_status") return "identity";
  return "market";
}

/**
 * Derives independently executable answer obligations from validated semantic
 * v1 output. No raw-message matching or provider behavior is consulted.
 */
export function deriveAnswerObligations(args: {
  interpretation: SemanticInterpretation;
  entities: readonly FinanceEntity[];
  intervals: readonly TemporalInterval[];
}): AnswerObligation[] {
  const { interpretation, entities, intervals } = args;
  const groups = new Map<string, ObligationGroup>();
  for (const source of effectiveInformationNeeds(interpretation)) {
    const kind = obligationKindFor(source.kind);
    for (const publicationRole of publicationRolesFor(source.kind)) {
      const lane = obligationLaneFor(source.kind, publicationRole);
      const key = `${kind}:${publicationRole}:${lane}`;
      const group = groups.get(key) ?? {
        kind,
        lane,
        publicationRole,
        sources: [],
      };
      group.sources.push(source);
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .sort(
      (left, right) =>
        Number(left.publicationRole === "narrative") -
        Number(right.publicationRole === "narrative")
    )
    .map((group) => {
      const relationalMode = relationalModeFor(
        interpretation,
        group.kind,
        entities
      );
      const obligationEntities = entitiesForRelationalMode(
        interpretation,
        entities,
        relationalMode
      );
      const obligationIntervals = intervalsForRelationalMode(
        interpretation,
        intervals,
        relationalMode
      );
      const sourceTemporalSpecIds =
        interpretation.semantic.comparison.temporalSpecIds.length > 0
          ? [...interpretation.semantic.comparison.temporalSpecIds]
          : interpretation.compiledTemporal.map((spec) => spec.id);
      const suffix =
        `${group.kind}:${group.publicationRole}:${group.lane}:` +
        relationalMode;
      const obligation = {
        id: `obligation:${interpretation.semantic.turnId}:${suffix}`,
        sectionId: `section:${interpretation.semantic.turnId}:${suffix}`,
        kind: group.kind,
        sourceNeedKinds: [
          ...new Set(group.sources.map((source) => source.kind)),
        ],
        sourceNeedIds: [
          ...new Set(
            group.sources.flatMap((source) => (source.id ? [source.id] : []))
          ),
        ],
        priority: group.sources.some(
          (source) => source.priority === "primary"
        )
          ? ("primary" as const)
          : ("supporting" as const),
        entities: obligationEntities,
        intervals: obligationIntervals,
        temporalMeaning: temporalMeaningFor(
          interpretation,
          sourceTemporalSpecIds
        ),
        relationalMode,
        sourceEntityMentionIds: [
          ...interpretation.semantic.comparison.entityMentionIds,
        ],
        sourceTemporalSpecIds,
        publicationRole: group.publicationRole,
      };
      return {
        ...obligation,
        needs: planNeedsForObligation(obligation, interpretation),
      };
    });
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
  const metricResolutions = resolveMetricCapabilities(
    interpretation.semantic.metrics
  );
  const obligations = deriveAnswerObligations({
    interpretation,
    entities,
    intervals,
  });

  return {
    version: 1,
    turnId: interpretation.semantic.turnId,
    asOf: now.toISOString(),
    calendar,
    standaloneQuery: interpretation.standaloneQuery,
    entities,
    intervals,
    obligations,
    needs: flattenObligationNeeds(obligations),
    metricResolutions,
    answerDepth: interpretation.semantic.answer.depth,
    comparison: interpretation.semantic.comparison.kind !== "none",
    causal: interpretation.semantic.intent.kind === "causal_analysis",
  };
}

/**
 * Produces the exact legacy-shaped plan the executor should run for one
 * obligation. In particular, document retrieval receives only that
 * obligation's entities, intervals and query.
 */
export function scopeGreenfieldPlanToObligation(
  plan: GreenfieldExecutionPlan,
  obligation: AnswerObligation
): GreenfieldExecutionPlan {
  return {
    ...plan,
    entities: obligation.entities,
    intervals: obligation.intervals,
    obligations: [obligation],
    needs: obligation.needs,
    comparison: obligation.relationalMode !== "none",
    causal: obligation.kind === "explain_cause",
  };
}

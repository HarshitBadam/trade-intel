import { detectCriteria, detectJurisdiction } from "./conversation-attributes";
import { resolveCorrections } from "./conversation-corrections";
import {
  resolveConversationGroups,
  updateConversationGroups,
} from "./conversation-groups";
import { resolveOrderedReferences } from "./conversation-ordered-references";
import {
  identifyReferenceAnchors,
  resolveEntityReferences,
  type ReferenceAnchors,
} from "./conversation-references";
import {
  baseConversationState,
  emptyConversationState,
} from "./conversation-state-base";
import {
  ORDERED_REFERENCE,
  RESET,
  normalizeOrderedReference,
  normalizeStateCommand,
} from "./entity-state-helpers";
import { primaryCalendar } from "./listing-capability";
import {
  intervalsToHorizon,
  mergeContrastIntervals,
  resolveTemporalContext,
  type TemporalInterval,
  type TemporalResolution,
} from "./temporal";
import type {
  ChatTurn,
  ConversationState,
  FinanceEntity,
} from "./types";

export { baseConversationState, emptyConversationState };

export type StateResolution = {
  state: ConversationState;
  entities: FinanceEntity[];
  clarification?: string;
  reasonCode: string;
  temporal: TemporalResolution;
};

function nextExplicitEntitySet(args: {
  base: ConversationState;
  direct: FinanceEntity[];
  explicit: FinanceEntity[];
  removed: FinanceEntity[];
  correctedExplicitSet: string[];
  fortuneReplacement: boolean;
  orderedMatch: boolean;
  subsetMatch: boolean;
  orderedPivot: boolean;
}): string[] {
  const {
    base,
    direct,
    explicit,
    removed,
    correctedExplicitSet,
    fortuneReplacement,
    orderedMatch,
    subsetMatch,
    orderedPivot,
  } = args;
  if (removed.length > 0) return correctedExplicitSet;
  if (fortuneReplacement) {
    return base.explicitEntitySet.flatMap((id) =>
      base.entities.find((entity) => entity.id === id)?.name === "Fortune 500"
        ? direct.map((entity) => entity.id)
        : [id]
    );
  }
  if (orderedMatch && !subsetMatch) {
    return orderedPivot
      ? [...new Set(explicit.map((entity) => entity.id))]
      : base.explicitEntitySet;
  }
  if (subsetMatch) {
    return [...new Set(direct.map((entity) => entity.id))];
  }
  return explicit.length > 0
    ? [...new Set(explicit.map((entity) => entity.id))]
    : base.explicitEntitySet;
}

function resolutionReasonCode(args: {
  removed: FinanceEntity[];
  grouped: FinanceEntity[];
  commandMessage: string;
  anchors: ReferenceAnchors;
  direct: FinanceEntity[];
  temporal: TemporalResolution;
  base: ConversationState;
}): string {
  if (args.removed.length > 0) return "entity_correction";
  if (args.grouped.length > 0) return "canonical_group_expanded";
  if (ORDERED_REFERENCE.test(args.commandMessage)) {
    return "ordered_reference_resolved";
  }
  if (args.anchors.anchor.length > 0) return "anchored_reference_resolved";
  if (args.anchors.referencesPlural || args.anchors.referencesSingular) {
    return "conversation_reference_resolved";
  }
  if (args.direct.length > 0) return "explicit_entities";
  if (args.temporal.status === "resolved" && args.base.entities.length > 0) {
    return "temporal_context_inherited";
  }
  return "no_entities";
}

export function resolveConversationState(
  message: string,
  previous: ConversationState | undefined,
  history: ChatTurn[] = [],
  options: { now?: Date } = {}
): StateResolution {
  const base = baseConversationState(previous, history);
  const commandMessage = normalizeOrderedReference(
    normalizeStateCommand(message),
    base.explicitEntitySet.length === 2
  );
  if (RESET.test(commandMessage)) {
    return {
      state: { ...emptyConversationState(), revision: base.revision + 1 },
      entities: [],
      reasonCode: "state_reset",
      temporal: { status: "none", intervals: [] },
    };
  }

  const corrections = resolveCorrections({
    message,
    commandMessage,
    base,
    history,
  });
  const groupResolution = resolveConversationGroups(message, base.entities);
  const ordered = resolveOrderedReferences({
    commandMessage,
    base,
    direct: corrections.direct,
  });
  if (ordered.status === "clarification") {
    return {
      state: base,
      entities: [],
      clarification: ordered.clarification,
      reasonCode: ordered.reasonCode,
      temporal: { status: "none", intervals: [] },
    };
  }

  const anchors = identifyReferenceAnchors({
    message,
    base,
    direct: ordered.direct,
    grouped: groupResolution.grouped,
    removed: corrections.removed,
    subsetMatch: ordered.subsetMatch,
    orderedMatch: ordered.orderedMatch,
    fortuneReplacement: corrections.fortuneReplacement,
  });
  const temporal = resolveTemporalContext({
    message,
    calendar: primaryCalendar(
      ordered.direct.length > 0 ||
        groupResolution.grouped.length > 0 ||
        anchors.indexReference.length > 0
        ? [
            ...ordered.direct,
            ...groupResolution.grouped,
            ...anchors.indexReference,
          ]
        : base.entities
    ),
    now: options.now,
  });
  const references = resolveEntityReferences({
    message,
    base,
    direct: ordered.direct,
    grouped: groupResolution.grouped,
    removed: corrections.removed,
    correctedBase: corrections.correctedBase,
    subsetMatch: ordered.subsetMatch,
    orderedMatch: ordered.orderedMatch,
    orderedPivot: ordered.orderedPivot,
    fortuneReplacement: corrections.fortuneReplacement,
    groupSwitch: groupResolution.groupSwitch,
    temporal,
    anchors,
  });

  const criteria = detectCriteria(message);
  const jurisdiction = detectJurisdiction(message, references.entities);
  const activeEntities = references.retainComparisonContext
    ? base.entities
    : corrections.removed.length > 0 || references.entities.length > 0
      ? references.entities
      : base.entities;
  const revision = base.revision + 1;
  const groups = updateConversationGroups({
    priorGroups: base.groups ?? [],
    namedGroups: groupResolution.namedGroups,
    activeEntities,
    revision,
  });
  const activeIds = new Set(activeEntities.map((entity) => entity.id));
  const explicitIds = [
    ...new Set(references.explicit.map((entity) => entity.id)),
  ].filter((id) => activeIds.has(id));
  const focusEntityIds =
    explicitIds.length > 0
      ? explicitIds
      : activeEntities.map((entity) => entity.id);
  const intervals: TemporalInterval[] =
    temporal.status === "invalid"
      ? []
      : mergeContrastIntervals({
          message,
          previous: references.startsNewTopic ? [] : (base.intervals ?? []),
          parsed:
            temporal.status === "resolved" ? temporal.intervals : [],
        });
  const next: ConversationState = {
    version: 1,
    revision,
    entities: activeEntities,
    explicitEntitySet: nextExplicitEntitySet({
      base,
      direct: ordered.direct,
      explicit: references.explicit,
      removed: corrections.removed,
      correctedExplicitSet: corrections.correctedExplicitSet,
      fortuneReplacement: corrections.fortuneReplacement,
      orderedMatch: ordered.orderedMatch,
      subsetMatch: ordered.subsetMatch,
      orderedPivot: ordered.orderedPivot,
    }),
    criteria:
      criteria.length > 0
        ? criteria
        : references.startsNewTopic
          ? []
          : base.criteria,
    horizon: intervalsToHorizon(intervals),
    jurisdiction:
      jurisdiction ??
      (references.startsNewTopic ? undefined : base.jurisdiction),
    safetyRepliesUsed: base.safetyRepliesUsed,
    ...(groups.length > 0 ? { groups } : {}),
    ...(focusEntityIds.length > 0 ? { focusEntityIds } : {}),
    ...(intervals.length > 0 ? { intervals } : {}),
  };
  return {
    state: next,
    entities: references.entities,
    temporal,
    reasonCode: resolutionReasonCode({
      removed: corrections.removed,
      grouped: groupResolution.grouped,
      commandMessage,
      anchors,
      direct: ordered.direct,
      temporal,
      base,
    }),
  };
}

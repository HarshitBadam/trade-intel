import type {
  ConversationReferenceFrame,
  ConversationTemporalAnchor,
  FinanceEntity,
} from "../types";
import type {
  CompiledTemporalSpec,
  GroundedGroupCandidate,
  SemanticGrounding,
  SemanticInterpretation,
  SemanticInterpreterContext,
} from "./semantic-interpreter";
import type {
  AnswerPreference,
  InformationNeed,
  MetricSpec,
  SemanticAmbiguity,
  SemanticAssumption,
  SemanticCorrection,
  SemanticIntent,
  SemanticTurn,
  TemporalSpec,
} from "./semantic-schema";

export type FieldProvenance = {
  turnId: string;
  source:
    | "model_extracted"
    | "catalog_grounded"
    | "inherited"
    | "corrected"
    | "default";
  confidence: number;
  sourceTurnId?: string;
  correctionId?: string;
};

export type CanonicalGroupState = {
  id: string;
  label: string;
  memberIds: readonly string[];
  confidence: number;
};

export type CanonicalTopic = {
  id: string;
  label?: string;
};

export type CanonicalLedgerState = {
  topic: CanonicalTopic;
  intent: SemanticIntent;
  informationNeeds: readonly InformationNeed[];
  entities: readonly FinanceEntity[];
  groups: readonly CanonicalGroupState[];
  metrics: readonly MetricSpec[];
  temporal: readonly TemporalSpec[];
  answer: AnswerPreference;
  ambiguities: readonly SemanticAmbiguity[];
  assumptions: readonly SemanticAssumption[];
  provenance: Readonly<Record<string, FieldProvenance>>;
  /** Recent ordered referents. Earlier history remains in ledger entries. */
  frames: readonly ConversationReferenceFrame[];
  /** The referent for singular/plural inheritance on the next turn. */
  focusEntityIds: readonly string[];
  /** Compiled active temporal meaning, preserving comparison positions. */
  activeTemporalAnchors: readonly ConversationTemporalAnchor[];
};

export type AppliedCorrection = {
  correction: SemanticCorrection;
  status: "applied" | "recorded" | "unresolved";
};

export type ConversationLedgerEntry = {
  sequence: number;
  turnId: string;
  userText: string;
  semantic: SemanticTurn;
  grounding: SemanticGrounding;
  standaloneQuery: string;
  corrections: readonly AppliedCorrection[];
  state: CanonicalLedgerState;
};

export type ConversationLedger = {
  version: 1;
  entries: readonly ConversationLedgerEntry[];
  /**
   * A bounded materialized starting point used when a public v1/v2 state is
   * rehydrated. It is not a fabricated historical entry.
   */
  checkpoint?: ConversationLedgerCheckpoint;
};

export type ConversationLedgerCheckpoint = {
  revision: number;
  state: CanonicalLedgerState;
  knownEntities: readonly FinanceEntity[];
  recentTurnIds: readonly string[];
  legacy: {
    explicitEntitySet: readonly string[];
    criteria: readonly string[];
    horizon?: string;
    jurisdiction?: string;
    safetyRepliesUsed?: readonly string[];
    pendingClarification?: string;
  };
};

type WorkingState = {
  topic: CanonicalTopic;
  intent: SemanticIntent;
  informationNeeds: InformationNeed[];
  entities: FinanceEntity[];
  groups: CanonicalGroupState[];
  metrics: MetricSpec[];
  temporal: TemporalSpec[];
  answer: AnswerPreference;
  ambiguities: SemanticAmbiguity[];
  assumptions: SemanticAssumption[];
  provenance: Record<string, FieldProvenance>;
  frames: ConversationReferenceFrame[];
  focusEntityIds: string[];
  activeTemporalAnchors: ConversationTemporalAnchor[];
};

export function createConversationLedger(): ConversationLedger {
  return Object.freeze({
    version: 1 as const,
    entries: Object.freeze([] as ConversationLedgerEntry[]),
  });
}

function uniqueEntities(values: readonly FinanceEntity[]): FinanceEntity[] {
  return [...new Map(values.map((entity) => [entity.id, entity])).values()];
}

function clearProvenancePrefix(
  provenance: Record<string, FieldProvenance>,
  prefix: string
): void {
  for (const key of Object.keys(provenance)) {
    if (key.startsWith(prefix)) delete provenance[key];
  }
}

function priorTurnForField(
  previous: CanonicalLedgerState | undefined,
  field: string
): string | undefined {
  return previous?.provenance[field]?.turnId;
}

function inheritedProvenance(
  turnId: string,
  sourceTurnId: string | undefined,
  confidence: number
): FieldProvenance {
  return {
    turnId,
    source: "inherited",
    confidence,
    ...(sourceTurnId ? { sourceTurnId } : {}),
  };
}

function groupState(group: GroundedGroupCandidate): CanonicalGroupState | null {
  if (group.status !== "grounded" || !group.selectedId) return null;
  return {
    id: group.selectedId,
    label: group.canonicalLabel ?? group.mention,
    memberIds: group.memberEntities.map((entity) => entity.id),
    confidence: group.confidence,
  };
}

function clonePrevious(
  previous: CanonicalLedgerState,
  semantic: SemanticTurn
): WorkingState {
  return {
    topic: { ...previous.topic },
    intent: semantic.intent.kind,
    informationNeeds: [...previous.informationNeeds],
    entities: [...previous.entities],
    groups: previous.groups.map((group) => ({
      ...group,
      memberIds: [...group.memberIds],
    })),
    metrics: [...previous.metrics],
    temporal: [...previous.temporal],
    answer: semantic.answer,
    ambiguities: [...semantic.ambiguities],
    assumptions: [...previous.assumptions],
    provenance: { ...previous.provenance },
    frames: previous.frames.map((frame) => ({
      ...frame,
      entityIds: [...frame.entityIds],
      groups: frame.groups.map((group) => ({
        ...group,
        memberIds: [...group.memberIds],
      })),
      temporalSpecIds: [...frame.temporalSpecIds],
      intervals: frame.intervals.map((interval) => ({ ...interval })),
    })),
    focusEntityIds: [...previous.focusEntityIds],
    activeTemporalAnchors: previous.activeTemporalAnchors.map((anchor) => ({
      ...anchor,
      interval: { ...anchor.interval },
    })),
  };
}

function freshState(semantic: SemanticTurn): WorkingState {
  return {
    topic: {
      id: `topic:${semantic.turnId}`,
      ...(semantic.topic.label ? { label: semantic.topic.label } : {}),
    },
    intent: semantic.intent.kind,
    informationNeeds: [],
    entities: [],
    groups: [],
    metrics: [],
    temporal: [],
    answer: semantic.answer,
    ambiguities: [...semantic.ambiguities],
    assumptions: [...semantic.assumptions],
    provenance: {},
    frames: [],
    focusEntityIds: [],
    activeTemporalAnchors: [],
  };
}

function applyExtractedState(
  state: WorkingState,
  previous: CanonicalLedgerState | undefined,
  interpretation: SemanticInterpretation
): void {
  const { semantic, grounding } = interpretation;
  const turnId = semantic.turnId;
  state.intent = semantic.intent.kind;
  state.answer = semantic.answer;
  state.provenance.intent = {
    turnId,
    source: "model_extracted",
    confidence: semantic.intent.confidence,
  };
  state.provenance.answer = {
    turnId,
    source: "model_extracted",
    confidence: semantic.answer.confidence,
  };
  state.provenance.topic = {
    turnId,
    source:
      semantic.topic.mode === "continue" ? "inherited" : "model_extracted",
    confidence: semantic.topic.confidence,
    ...(semantic.topic.mode === "continue" && previous
      ? { sourceTurnId: priorTurnForField(previous, "topic") }
      : {}),
  };

  if (semantic.assumptions.length > 0) {
    state.assumptions = [
      ...new Map(
        [...state.assumptions, ...semantic.assumptions].map((assumption) => [
          assumption.id,
          assumption,
        ])
      ).values(),
    ];
    for (const assumption of semantic.assumptions) {
      state.provenance[`assumptions.${assumption.id}`] = {
        turnId,
        source: "model_extracted",
        confidence: assumption.confidence,
      };
    }
  }

  if (semantic.informationNeeds.length > 0) {
    state.informationNeeds = [...semantic.informationNeeds];
    clearProvenancePrefix(state.provenance, "informationNeeds.");
    for (const need of semantic.informationNeeds) {
      state.provenance[`informationNeeds.${need.id}`] = {
        turnId,
        source: "model_extracted",
        confidence: semantic.confidence,
      };
    }
  }

  const mentionById = new Map(
    semantic.entities.mentions.map((mention) => [mention.mentionId, mention])
  );
  const explicitEntities = grounding.entityMentions
    .filter((item) => {
      const role = mentionById.get(item.mentionId)?.role;
      return item.entity && role !== "excluded";
    })
    .map((item) => item.entity as FinanceEntity);
  const selectedGroups = grounding.groups
    .map(groupState)
    .filter((group): group is CanonicalGroupState => Boolean(group));
  const groupEntities = grounding.groups.flatMap((group) =>
    group.status === "grounded" ? group.memberEntities : []
  );
  const currentEntities = uniqueEntities([
    ...grounding.inheritedEntities,
    ...explicitEntities,
    ...groupEntities,
  ]);
  const attemptedExplicitScope =
    semantic.entities.mentions.some((mention) => mention.role !== "excluded") ||
    semantic.entities.groupCandidates.length > 0 ||
    semantic.entities.inheritance.mode !== "none";

  if (currentEntities.length > 0 || attemptedExplicitScope) {
    state.entities = currentEntities;
    clearProvenancePrefix(state.provenance, "entities.");
    const inheritedIds = new Set(
      grounding.inheritedEntities.map((entity) => entity.id)
    );
    for (const entity of currentEntities) {
      const mention = grounding.entityMentions.find(
        (item) => item.entity?.id === entity.id
      );
      const sourceTurnId = priorTurnForField(previous, `entities.${entity.id}`);
      state.provenance[`entities.${entity.id}`] = inheritedIds.has(entity.id)
        ? inheritedProvenance(
            turnId,
            semantic.entities.inheritance.sourceTurnId ?? sourceTurnId,
            semantic.entities.inheritance.confidence
          )
        : {
            turnId,
            source: "catalog_grounded",
            confidence:
              mention?.confidence ??
              selectedGroups.find((group) =>
                group.memberIds.includes(entity.id)
              )?.confidence ??
              semantic.entities.confidence,
          };
    }
  }

  if (selectedGroups.length > 0) {
    state.groups = selectedGroups;
    clearProvenancePrefix(state.provenance, "groups.");
    for (const group of selectedGroups) {
      state.provenance[`groups.${group.id}`] = {
        turnId,
        source: "catalog_grounded",
        confidence: group.confidence,
      };
    }
  } else if (
    semantic.entities.groupCandidates.length > 0 ||
    semantic.topic.mode !== "continue"
  ) {
    state.groups = [];
    clearProvenancePrefix(state.provenance, "groups.");
  }

  if (semantic.metrics.length > 0) {
    state.metrics = [...semantic.metrics];
    clearProvenancePrefix(state.provenance, "metrics.");
    for (const metric of semantic.metrics) {
      state.provenance[`metrics.${metric.id}`] = {
        turnId,
        source: "model_extracted",
        confidence: metric.confidence,
      };
    }
  }

  const hasTemporalCorrection = semantic.corrections.some(
    (correction) =>
      correction.field === "temporal" && correction.operation !== "clarify"
  );
  if (semantic.temporal.specs.length > 0 && !hasTemporalCorrection) {
    state.temporal = [...semantic.temporal.specs];
    clearProvenancePrefix(state.provenance, "temporal.");
    for (const spec of semantic.temporal.specs) {
      state.provenance[`temporal.${spec.id}`] = {
        turnId,
        source:
          spec.source === "inherited"
            ? "inherited"
            : spec.source === "default"
              ? "default"
              : "model_extracted",
        confidence: spec.confidence,
        ...(spec.source === "inherited"
          ? {
              sourceTurnId:
                semantic.entities.inheritance.sourceTurnId ??
                priorTurnForField(previous, `temporal.${spec.id}`),
            }
          : {}),
      };
    }
  } else if (semantic.temporal.inherit === "active" && previous) {
    state.temporal = [...previous.temporal];
    for (const spec of state.temporal) {
      state.provenance[`temporal.${spec.id}`] = inheritedProvenance(
        turnId,
        priorTurnForField(previous, `temporal.${spec.id}`),
        semantic.temporal.confidence
      );
    }
  } else if (semantic.temporal.inherit === "none") {
    state.temporal = [];
    clearProvenancePrefix(state.provenance, "temporal.");
  }
}

function temporalAssumptionIds(spec: TemporalSpec): string[] {
  if (spec.kind === "range") {
    return spec.assumptionId ? [spec.assumptionId] : [];
  }
  if (spec.kind !== "comparison") return [];
  return [spec.left, spec.right].flatMap((anchor) =>
    anchor.kind === "range" && anchor.assumptionId
      ? [anchor.assumptionId]
      : []
  );
}

function pruneUnusedTemporalAssumptions(state: WorkingState): void {
  const activeIds = new Set(state.temporal.flatMap(temporalAssumptionIds));
  const removedIds = state.assumptions
    .filter(
      (assumption) =>
        assumption.field === "temporal" && !activeIds.has(assumption.id)
    )
    .map((assumption) => assumption.id);
  state.assumptions = state.assumptions.filter(
    (assumption) =>
      assumption.field !== "temporal" || activeIds.has(assumption.id)
  );
  for (const id of removedIds) delete state.provenance[`assumptions.${id}`];
}

function correctionEntity(
  correction: SemanticCorrection,
  interpretation: SemanticInterpretation
): FinanceEntity | undefined {
  const id = correction.replacementId ?? correction.value;
  if (!id) return undefined;
  return interpretation.grounding.entityMentions.find(
    (mention) =>
      mention.entity?.id === id ||
      mention.mentionId === id ||
      mention.entity?.name === id ||
      mention.entity?.ticker === id
  )?.entity;
}

function correctionGroup(
  correction: SemanticCorrection,
  interpretation: SemanticInterpretation
): CanonicalGroupState | undefined {
  const id = correction.replacementId ?? correction.value;
  if (!id) return undefined;
  const group = interpretation.grounding.groups.find(
    (candidate) => candidate.selectedId === id || candidate.mention === id
  );
  return group ? groupState(group) ?? undefined : undefined;
}

function markCorrection(
  state: WorkingState,
  path: string,
  turnId: string,
  correction: SemanticCorrection
): void {
  state.provenance[path] = {
    turnId,
    source: "corrected",
    confidence: correction.confidence,
    correctionId: correction.id,
  };
}

function resetTopicState(state: WorkingState, semantic: SemanticTurn): void {
  state.topic = {
    id: `topic:${semantic.turnId}`,
    ...(semantic.topic.label ? { label: semantic.topic.label } : {}),
  };
  state.informationNeeds = [];
  state.entities = [];
  state.groups = [];
  state.metrics = [];
  state.temporal = [];
  state.frames = [];
  state.focusEntityIds = [];
  state.activeTemporalAnchors = [];
  state.provenance = {};
}

function applyCorrection(
  state: WorkingState,
  correction: SemanticCorrection,
  interpretation: SemanticInterpretation
): AppliedCorrection {
  const turnId = interpretation.semantic.turnId;
  if (correction.operation === "clarify") {
    return { correction, status: "recorded" };
  }

  if (correction.field === "topic") {
    if (correction.operation === "reset" || correction.operation === "replace") {
      resetTopicState(state, interpretation.semantic);
      markCorrection(state, "topic", turnId, correction);
      return { correction, status: "applied" };
    }
    return { correction, status: "unresolved" };
  }

  if (correction.field === "entity") {
    if (correction.operation === "reset") {
      state.entities = [];
      state.groups = [];
      clearProvenancePrefix(state.provenance, "entities.");
      clearProvenancePrefix(state.provenance, "groups.");
      markCorrection(state, "entities", turnId, correction);
      return { correction, status: "applied" };
    }
    const targetIndex = state.entities.findIndex(
      (entity) =>
        entity.id === correction.targetId ||
        entity.name === correction.targetId ||
        entity.ticker === correction.targetId
    );
    if (correction.operation === "remove") {
      if (targetIndex < 0) return { correction, status: "unresolved" };
      const [removed] = state.entities.splice(targetIndex, 1);
      delete state.provenance[`entities.${removed.id}`];
      markCorrection(state, `entities.removed.${removed.id}`, turnId, correction);
      state.groups = state.groups
        .map((group) => ({
          ...group,
          memberIds: group.memberIds.filter((id) => id !== removed.id),
        }))
        .filter((group) => group.memberIds.length > 0);
      return { correction, status: "applied" };
    }
    const replacement = correctionEntity(correction, interpretation);
    if (!replacement) return { correction, status: "unresolved" };
    if (correction.operation === "add") {
      state.entities = uniqueEntities([...state.entities, replacement]);
      markCorrection(
        state,
        `entities.${replacement.id}`,
        turnId,
        correction
      );
      return { correction, status: "applied" };
    }
    if (correction.operation === "replace" && targetIndex >= 0) {
      const [removed] = state.entities.splice(targetIndex, 1, replacement);
      state.entities = uniqueEntities(state.entities);
      delete state.provenance[`entities.${removed.id}`];
      markCorrection(
        state,
        `entities.${replacement.id}`,
        turnId,
        correction
      );
      return { correction, status: "applied" };
    }
    return { correction, status: "unresolved" };
  }

  if (correction.field === "group") {
    if (correction.operation === "reset") {
      state.groups = [];
      clearProvenancePrefix(state.provenance, "groups.");
      markCorrection(state, "groups", turnId, correction);
      return { correction, status: "applied" };
    }
    const targetIndex = state.groups.findIndex(
      (group) => group.id === correction.targetId
    );
    if (correction.operation === "remove") {
      if (targetIndex < 0) return { correction, status: "unresolved" };
      const [removed] = state.groups.splice(targetIndex, 1);
      delete state.provenance[`groups.${removed.id}`];
      markCorrection(state, `groups.removed.${removed.id}`, turnId, correction);
      return { correction, status: "applied" };
    }
    const replacement = correctionGroup(correction, interpretation);
    if (!replacement) return { correction, status: "unresolved" };
    if (correction.operation === "add") {
      state.groups = [
        ...new Map(
          [...state.groups, replacement].map((group) => [group.id, group])
        ).values(),
      ];
      state.entities = uniqueEntities([
        ...state.entities,
        ...interpretation.grounding.groups
          .filter((group) => group.selectedId === replacement.id)
          .flatMap((group) => group.memberEntities),
      ]);
      markCorrection(state, `groups.${replacement.id}`, turnId, correction);
      return { correction, status: "applied" };
    }
    if (correction.operation === "replace" && targetIndex >= 0) {
      const [removed] = state.groups.splice(targetIndex, 1, replacement);
      delete state.provenance[`groups.${removed.id}`];
      markCorrection(state, `groups.${replacement.id}`, turnId, correction);
      return { correction, status: "applied" };
    }
    return { correction, status: "unresolved" };
  }

  if (correction.field === "temporal") {
    if (correction.operation === "reset") {
      state.temporal = [];
      clearProvenancePrefix(state.provenance, "temporal.");
      pruneUnusedTemporalAssumptions(state);
      markCorrection(state, "temporal", turnId, correction);
      return { correction, status: "applied" };
    }
    const targetIndex = state.temporal.findIndex(
      (item) => item.id === correction.targetId
    );
    if (correction.operation === "remove") {
      if (targetIndex < 0) return { correction, status: "unresolved" };
      const [removed] = state.temporal.splice(targetIndex, 1);
      delete state.provenance[`temporal.${removed.id}`];
      pruneUnusedTemporalAssumptions(state);
      markCorrection(
        state,
        `temporal.removed.${removed.id}`,
        turnId,
        correction
      );
      return { correction, status: "applied" };
    }
    const replacementId = correction.replacementId ?? correction.value;
    const replacement = interpretation.semantic.temporal.specs.find(
      (item) => item.id === replacementId
    );
    if (!replacement) return { correction, status: "unresolved" };
    if (correction.operation === "add") {
      state.temporal = [
        ...new Map(
          [...state.temporal, replacement].map((item) => [item.id, item])
        ).values(),
      ];
      markCorrection(state, `temporal.${replacement.id}`, turnId, correction);
      return { correction, status: "applied" };
    }
    if (correction.operation === "replace" && targetIndex >= 0) {
      const [removed] = state.temporal.splice(
        targetIndex,
        1,
        replacement
      );
      delete state.provenance[`temporal.${removed.id}`];
      pruneUnusedTemporalAssumptions(state);
      markCorrection(state, `temporal.${replacement.id}`, turnId, correction);
      return { correction, status: "applied" };
    }
    return { correction, status: "unresolved" };
  }

  const collection =
    correction.field === "metric"
      ? state.metrics
      : correction.field === "information_need"
          ? state.informationNeeds
          : undefined;
  if (!collection) return { correction, status: "unresolved" };

  const prefix =
    correction.field === "information_need"
      ? "informationNeeds"
      : "metrics";
  if (correction.operation === "reset") {
    collection.splice(0);
    clearProvenancePrefix(state.provenance, `${prefix}.`);
    markCorrection(state, prefix, turnId, correction);
    return { correction, status: "applied" };
  }
  const targetIndex = collection.findIndex(
    (item) => item.id === correction.targetId
  );
  if (correction.operation === "remove" && targetIndex >= 0) {
    const [removed] = collection.splice(targetIndex, 1);
    delete state.provenance[`${prefix}.${removed.id}`];
    markCorrection(
      state,
      `${prefix}.removed.${removed.id}`,
      turnId,
      correction
    );
    return { correction, status: "applied" };
  }
  const replacements =
    correction.field === "metric"
      ? interpretation.semantic.metrics
      : interpretation.semantic.informationNeeds;
  const replacementId = correction.replacementId ?? correction.value;
  const replacement = replacements.find((item) => item.id === replacementId);
  if (!replacement) return { correction, status: "unresolved" };
  if (correction.operation === "add") {
    collection.push(replacement as never);
    markCorrection(state, `${prefix}.${replacement.id}`, turnId, correction);
    return { correction, status: "applied" };
  }
  if (correction.operation === "replace" && targetIndex >= 0) {
    const [removed] = collection.splice(targetIndex, 1, replacement as never);
    delete state.provenance[`${prefix}.${removed.id}`];
    markCorrection(state, `${prefix}.${replacement.id}`, turnId, correction);
    return { correction, status: "applied" };
  }
  return { correction, status: "unresolved" };
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compiledAnchors(
  compiled: readonly CompiledTemporalSpec[]
): ConversationTemporalAnchor[] {
  return compiled
    .flatMap((spec) =>
      spec.intervals.map((interval, position) => ({
        specId: spec.id,
        position,
        interval: { ...interval },
      }))
    )
    .slice(0, 8);
}

function updateActiveTemporalAnchors(
  state: WorkingState,
  previous: CanonicalLedgerState | undefined,
  compiled: readonly CompiledTemporalSpec[]
): void {
  const compiledBySpec = new Map<string, ConversationTemporalAnchor[]>();
  for (const anchor of compiledAnchors(compiled)) {
    const values = compiledBySpec.get(anchor.specId) ?? [];
    values.push(anchor);
    compiledBySpec.set(anchor.specId, values);
  }
  const previousBySpec = new Map<string, ConversationTemporalAnchor[]>();
  for (const anchor of previous?.activeTemporalAnchors ?? []) {
    const values = previousBySpec.get(anchor.specId) ?? [];
    values.push({ ...anchor, interval: { ...anchor.interval } });
    previousBySpec.set(anchor.specId, values);
  }
  state.activeTemporalAnchors = state.temporal
    .flatMap(
      (spec) => compiledBySpec.get(spec.id) ?? previousBySpec.get(spec.id) ?? []
    )
    .slice(0, 8);
}

function frameEntityOrder(
  state: WorkingState,
  interpretation: SemanticInterpretation
): string[] {
  const byMentionId = new Map(
    interpretation.grounding.entityMentions.map((mention) => [
      mention.mentionId,
      mention.entity,
    ])
  );
  const mentioned = interpretation.semantic.entities.mentions.flatMap(
    (mention) => {
      const entity = byMentionId.get(mention.mentionId);
      return entity && mention.role !== "excluded" ? [entity.id] : [];
    }
  );
  const groups = interpretation.grounding.groups.flatMap((group) =>
    group.status === "grounded"
      ? group.memberEntities.map((entity) => entity.id)
      : []
  );
  const inherited = interpretation.grounding.inheritedEntities.map(
    (entity) => entity.id
  );
  const activeIds = new Set(state.entities.map((entity) => entity.id));
  return uniqueIds([...inherited, ...mentioned, ...groups])
    .filter((id) => activeIds.has(id))
    .concat(
      state.entities
        .map((entity) => entity.id)
        .filter(
          (id) =>
            !uniqueIds([...inherited, ...mentioned, ...groups]).includes(id)
        )
    )
    .slice(0, 12);
}

function turnFocusEntityIds(
  state: WorkingState,
  interpretation: SemanticInterpretation
): string[] {
  const activeIds = new Set(state.entities.map((entity) => entity.id));
  const selectedGroups = interpretation.grounding.groups.filter(
    (group) => group.status === "grounded"
  );
  const lastGroup = selectedGroups.at(-1);
  if (lastGroup) {
    const groupFocus = lastGroup.memberEntities
      .map((entity) => entity.id)
      .filter((id) => activeIds.has(id));
    if (groupFocus.length > 0) return uniqueIds(groupFocus).slice(0, 12);
  }
  const mentioned = interpretation.semantic.entities.mentions.flatMap(
    (mention) => {
      if (mention.role === "excluded") return [];
      const grounded = interpretation.grounding.entityMentions.find(
        (item) => item.mentionId === mention.mentionId
      )?.entity;
      return grounded && activeIds.has(grounded.id) ? [grounded.id] : [];
    }
  );
  if (mentioned.length > 0) return uniqueIds(mentioned).slice(0, 12);
  const inherited = interpretation.grounding.inheritedEntities
    .map((entity) => entity.id)
    .filter((id) => activeIds.has(id));
  return uniqueIds(
    inherited.length > 0
      ? inherited
      : state.entities.map((entity) => entity.id)
  ).slice(0, 12);
}

function shouldCreateFrame(interpretation: SemanticInterpretation): boolean {
  const { semantic, grounding } = interpretation;
  const explicitNamedEntity = semantic.entities.mentions.some((mention) =>
    ["explicit", "category", "group_member"].includes(mention.reference)
  );
  const correctedScope = semantic.corrections.some(
    (correction) =>
      (correction.field === "entity" || correction.field === "group") &&
      correction.operation !== "clarify"
  );
  const pluralTemporalReference =
    semantic.temporal.specs.length > 0 &&
    ["plural", "all_active"].includes(semantic.entities.inheritance.mode);
  return (
    semantic.comparison.kind !== "none" ||
    grounding.groups.some((group) => group.status === "grounded") ||
    explicitNamedEntity ||
    correctedScope ||
    pluralTemporalReference
  );
}

function updateContinuityState(
  state: WorkingState,
  previous: CanonicalLedgerState | undefined,
  interpretation: SemanticInterpretation
): void {
  updateActiveTemporalAnchors(
    state,
    previous,
    interpretation.compiledTemporal
  );
  state.focusEntityIds = turnFocusEntityIds(state, interpretation);
  if (!shouldCreateFrame(interpretation) || state.entities.length === 0) return;

  const entityIds = frameEntityOrder(state, interpretation);
  const groups = interpretation.grounding.groups
    .filter(
      (
        group
      ): group is GroundedGroupCandidate & {
        selectedId: string;
        status: "grounded";
      } => group.status === "grounded" && Boolean(group.selectedId)
    )
    .map((group) => ({
      id: group.selectedId,
      qualification: group.mention,
      memberIds: group.memberEntities
        .map((entity) => entity.id)
        .filter((id) => entityIds.includes(id))
        .slice(0, 12),
    }))
    .filter((group) => group.memberIds.length > 0)
    .slice(0, 4);
  const requestedTemporalIds =
    interpretation.semantic.comparison.temporalSpecIds.length > 0
      ? interpretation.semantic.comparison.temporalSpecIds
      : state.temporal.map((spec) => spec.id);
  const temporalSpecIds = uniqueIds(requestedTemporalIds).slice(0, 8);
  const temporalIdSet = new Set(temporalSpecIds);
  const intervals = state.activeTemporalAnchors
    .filter((anchor) => temporalIdSet.has(anchor.specId))
    .map((anchor) => ({ ...anchor.interval }))
    .slice(0, 8);
  const frame: ConversationReferenceFrame = {
    id: `frame:${interpretation.semantic.turnId}`.slice(0, 80),
    kind:
      interpretation.semantic.comparison.kind === "none"
        ? "reference"
        : "comparison",
    entityIds,
    groups,
    temporalSpecIds,
    intervals,
  };
  state.frames = [...state.frames, frame].slice(-4);
}

function freezeState(state: WorkingState): CanonicalLedgerState {
  const groups = state.groups.map((group) =>
    Object.freeze({
      ...group,
      memberIds: Object.freeze([...group.memberIds]),
    })
  );
  const frames = state.frames.map((frame) =>
    Object.freeze({
      ...frame,
      entityIds: Object.freeze([...frame.entityIds]),
      groups: Object.freeze(
        frame.groups.map((group) =>
          Object.freeze({
            ...group,
            memberIds: Object.freeze([...group.memberIds]),
          })
        )
      ),
      temporalSpecIds: Object.freeze([...frame.temporalSpecIds]),
      intervals: Object.freeze(
        frame.intervals.map((interval) => Object.freeze({ ...interval }))
      ),
    })
  );
  const activeTemporalAnchors = state.activeTemporalAnchors.map((anchor) =>
    Object.freeze({
      ...anchor,
      interval: Object.freeze({ ...anchor.interval }),
    })
  );
  return Object.freeze({
    topic: Object.freeze({ ...state.topic }),
    intent: state.intent,
    informationNeeds: Object.freeze([...state.informationNeeds]),
    entities: Object.freeze([...state.entities]),
    groups: Object.freeze(groups),
    metrics: Object.freeze([...state.metrics]),
    temporal: Object.freeze([...state.temporal]),
    answer: Object.freeze({ ...state.answer }),
    ambiguities: Object.freeze([...state.ambiguities]),
    assumptions: Object.freeze([...state.assumptions]),
    provenance: Object.freeze({ ...state.provenance }),
    frames: Object.freeze(frames),
    focusEntityIds: Object.freeze([...state.focusEntityIds]),
    activeTemporalAnchors: Object.freeze(activeTemporalAnchors),
  });
}

export function appendConversationTurn(
  ledger: ConversationLedger,
  interpretation: SemanticInterpretation
): ConversationLedger {
  const semantic = interpretation.semantic;
  if (ledger.entries.some((entry) => entry.turnId === semantic.turnId)) {
    throw new Error(`Ledger already contains turn: ${semantic.turnId}`);
  }

  const previous = latestLedgerState(ledger);
  const startsFresh =
    !previous ||
    semantic.topic.mode === "pivot" ||
    semantic.topic.mode === "reset";
  const state = startsFresh
    ? freshState(semantic)
    : clonePrevious(previous, semantic);
  applyExtractedState(state, startsFresh ? undefined : previous, interpretation);
  const corrections = semantic.corrections.map((correction) =>
    applyCorrection(state, correction, interpretation)
  );
  updateContinuityState(
    state,
    startsFresh ? undefined : previous,
    interpretation
  );
  const entry: ConversationLedgerEntry = Object.freeze({
    sequence: (ledger.checkpoint?.revision ?? 0) + ledger.entries.length,
    turnId: semantic.turnId,
    userText: semantic.originalText,
    semantic,
    grounding: interpretation.grounding,
    standaloneQuery: interpretation.standaloneQuery,
    corrections: Object.freeze(corrections),
    state: freezeState(state),
  });
  return Object.freeze({
    version: 1 as const,
    entries: Object.freeze([...ledger.entries, entry]),
    ...(ledger.checkpoint ? { checkpoint: ledger.checkpoint } : {}),
  });
}

export function latestLedgerState(
  ledger: ConversationLedger
): CanonicalLedgerState | undefined {
  return ledger.entries.at(-1)?.state ?? ledger.checkpoint?.state;
}

export function ledgerInterpreterContext(
  ledger: ConversationLedger
): SemanticInterpreterContext {
  const state = latestLedgerState(ledger);
  if (!state) {
    return {
      activeEntities: [],
      activeGroups: [],
      activeTemporal: [],
      recentTurnIds: [],
      knownEntities: [],
      orderedEntities: [],
      focusEntities: [],
    };
  }
  const entityIndex = new Map(
    [
      ...(ledger.checkpoint?.knownEntities ?? []),
      ...ledger.entries.flatMap((entry) => entry.state.entities),
      ...state.entities,
    ].map((entity) => [entity.id, entity])
  );
  const latestFrame = state.frames.at(-1);
  const frameEntities = (latestFrame?.entityIds ?? [])
    .map((id) => entityIndex.get(id))
    .filter((entity): entity is FinanceEntity => Boolean(entity));
  const focusEntities = state.focusEntityIds
    .map((id) => entityIndex.get(id))
    .filter((entity): entity is FinanceEntity => Boolean(entity));
  const activeEntities =
    frameEntities.length > 0
      ? frameEntities
      : focusEntities.length > 0
        ? focusEntities
        : [...state.entities];
  const groups =
    latestFrame
      ? latestFrame.groups.map((frameGroup) => {
          const canonical = state.groups.find(
            (group) => group.id === frameGroup.id
          );
          return {
            id: frameGroup.id,
            label: canonical?.label ?? frameGroup.qualification,
            memberIds: frameGroup.memberIds,
          };
        })
      : state.groups;
  return {
    activeEntities,
    activeGroups: groups,
    activeTemporal: state.temporal,
    recentTurnIds: [
      ...(ledger.checkpoint?.recentTurnIds ?? []),
      ...ledger.entries.map((entry) => entry.turnId),
    ].slice(-8),
    knownEntities: [...entityIndex.values()].slice(-12),
    orderedEntities: frameEntities.length >= 2 ? frameEntities : [],
    focusEntities,
  };
}

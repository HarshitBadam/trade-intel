import { intervalsToHorizon, type TemporalInterval } from "../temporal";
import type {
  ConversationFrameGroupRef,
  ConversationReferenceFrame,
  ConversationState,
  ConversationStateV2,
  ConversationTemporalAnchor,
  FinanceEntity,
  NamedGroupRef,
} from "../types";
import {
  createConversationLedger,
  type CanonicalGroupState,
  type CanonicalLedgerState,
  type ConversationLedger,
  type ConversationLedgerCheckpoint,
} from "./conversation-ledger";
import type { TemporalAnchor, TemporalSpec } from "./semantic-schema";

const MAX_ENTITIES = 12;
const MAX_GROUPS = 4;
const MAX_FRAMES = 4;
const MAX_INTERVALS = 8;

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cloneInterval(interval: TemporalInterval): TemporalInterval {
  return { ...interval };
}

function intervalAnchor(interval: TemporalInterval): TemporalAnchor {
  if (interval.startSession === interval.endSession) {
    return {
      kind: "point",
      label: interval.label,
      value: { type: "absolute", date: interval.startSession },
    };
  }
  return {
    kind: "range",
    label: interval.label,
    start: { type: "absolute", date: interval.startSession },
    end: { type: "absolute", date: interval.endSession },
  };
}

function semanticTemporal(
  anchors: readonly ConversationTemporalAnchor[]
): TemporalSpec[] {
  const bySpec = new Map<string, ConversationTemporalAnchor[]>();
  for (const anchor of anchors) {
    const values = bySpec.get(anchor.specId) ?? [];
    values.push(anchor);
    bySpec.set(anchor.specId, values);
  }
  const specs: TemporalSpec[] = [];
  for (const [id, values] of bySpec) {
    const ordered = [...values].sort(
      (left, right) => left.position - right.position
    );
    const first = ordered[0];
    if (!first) continue;
    const source = first.interval.source;
    if (ordered.length >= 2) {
      specs.push({
        id,
        kind: "comparison",
        label: ordered
          .slice(0, 2)
          .map((anchor) => anchor.interval.label)
          .join(" versus "),
        left: intervalAnchor(ordered[0].interval),
        right: intervalAnchor(ordered[1].interval),
        source,
        confidence: 1,
      });
      continue;
    }
    const interval = first.interval;
    specs.push(
      interval.startSession === interval.endSession
        ? {
            id,
            kind: "point",
            label: interval.label,
            value: { type: "absolute", date: interval.startSession },
            source,
            confidence: 1,
          }
        : {
            id,
            kind: "range",
            label: interval.label,
            start: { type: "absolute", date: interval.startSession },
            end: { type: "absolute", date: interval.endSession },
            source,
            confidence: 1,
          }
    );
  }
  return specs;
}

function sanitizeGroups(
  groups: readonly NamedGroupRef[] | undefined,
  entityIds: Set<string>
): NamedGroupRef[] {
  return (groups ?? [])
    .map((group) => ({
      id: String(group.id).slice(0, 60),
      label: String(group.label).slice(0, 80),
      memberIds: uniqueIds(group.memberIds ?? [])
        .filter((id) => entityIds.has(id))
        .slice(0, MAX_ENTITIES),
      namedAtRevision: Math.max(
        0,
        Math.min(Number(group.namedAtRevision) || 0, 10_000)
      ),
    }))
    .filter((group) => group.id && group.label && group.memberIds.length > 0)
    .slice(-MAX_GROUPS);
}

function sanitizeFrameGroups(
  groups: readonly ConversationFrameGroupRef[],
  frameEntityIds: Set<string>
): ConversationFrameGroupRef[] {
  return groups
    .map((group) => ({
      id: String(group.id).slice(0, 60),
      qualification: String(group.qualification).slice(0, 120),
      memberIds: uniqueIds(group.memberIds)
        .filter((id) => frameEntityIds.has(id))
        .slice(0, MAX_ENTITIES),
    }))
    .filter(
      (group) =>
        group.id && group.qualification && group.memberIds.length > 0
    )
    .slice(0, MAX_GROUPS);
}

function sanitizeFrames(
  frames: readonly ConversationReferenceFrame[],
  entityIds: Set<string>
): ConversationReferenceFrame[] {
  return frames
    .map((frame) => {
      const orderedIds = uniqueIds(frame.entityIds)
        .filter((id) => entityIds.has(id))
        .slice(0, MAX_ENTITIES);
      return {
        id: String(frame.id).slice(0, 80),
        kind: frame.kind === "comparison" ? ("comparison" as const) : ("reference" as const),
        entityIds: orderedIds,
        groups: sanitizeFrameGroups(frame.groups ?? [], new Set(orderedIds)),
        temporalSpecIds: uniqueIds(frame.temporalSpecIds ?? []).slice(
          0,
          MAX_INTERVALS
        ),
        intervals: (frame.intervals ?? [])
          .slice(0, MAX_INTERVALS)
          .map(cloneInterval),
      };
    })
    .filter((frame) => frame.id && frame.entityIds.length > 0)
    .slice(-MAX_FRAMES);
}

function anchorsFromV1Intervals(
  intervals: readonly TemporalInterval[]
): ConversationTemporalAnchor[] {
  return intervals.slice(0, MAX_INTERVALS).map((interval, position) => ({
    specId: `legacy-temporal-${position + 1}`,
    position: 0,
    interval: cloneInterval(interval),
  }));
}

function frameFromV1(
  state: ConversationState,
  entityIds: Set<string>,
  groups: readonly NamedGroupRef[],
  anchors: readonly ConversationTemporalAnchor[]
): ConversationReferenceFrame[] {
  const orderedIds = uniqueIds(
    state.explicitEntitySet.length > 0
      ? state.explicitEntitySet
      : state.focusEntityIds && state.focusEntityIds.length > 0
        ? state.focusEntityIds
        : state.entities.map((entity) => entity.id)
  )
    .filter((id) => entityIds.has(id))
    .slice(0, MAX_ENTITIES);
  if (orderedIds.length === 0) return [];
  return [
    {
      id: `frame:state:${state.revision}`,
      kind: orderedIds.length > 1 ? "comparison" : "reference",
      entityIds: orderedIds,
      groups: groups
        .map((group) => ({
          id: group.id,
          qualification: group.label,
          memberIds: group.memberIds.filter((id) => orderedIds.includes(id)),
        }))
        .filter((group) => group.memberIds.length > 0),
      temporalSpecIds: uniqueIds(anchors.map((anchor) => anchor.specId)),
      intervals: anchors.map((anchor) => cloneInterval(anchor.interval)),
    },
  ];
}

function canonicalGroups(groups: readonly NamedGroupRef[]): CanonicalGroupState[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    memberIds: [...group.memberIds],
    confidence: 1,
  }));
}

function canonicalStateFromConversationState(
  state: ConversationState,
  entities: readonly FinanceEntity[],
  groups: readonly NamedGroupRef[],
  frames: readonly ConversationReferenceFrame[],
  focusEntityIds: readonly string[],
  anchors: readonly ConversationTemporalAnchor[]
): CanonicalLedgerState {
  const latestFrame = frames.at(-1);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const activeIds =
    latestFrame?.entityIds.length
      ? latestFrame.entityIds
      : focusEntityIds.length > 0
        ? focusEntityIds
        : entities.map((entity) => entity.id);
  const activeEntities = activeIds
    .map((id) => byId.get(id))
    .filter((entity): entity is FinanceEntity => Boolean(entity));
  return {
    topic: { id: `topic:state:${state.revision}` },
    intent:
      activeEntities.length > 1 ? "entity_comparison" : "entity_snapshot",
    informationNeeds: [],
    entities: activeEntities,
    groups: canonicalGroups(groups),
    metrics: [],
    temporal: semanticTemporal(anchors),
    answer: { depth: "standard", format: "prose", confidence: 1 },
    ambiguities: [],
    assumptions: [],
    provenance: {},
    frames,
    focusEntityIds,
    activeTemporalAnchors: anchors,
  };
}

/**
 * Rehydrates bounded public state into a canonical ledger checkpoint. No
 * historical semantic turns are invented, and a missing state starts empty.
 */
export function ledgerFromConversationState(
  state?: ConversationState
): ConversationLedger {
  if (!state) return createConversationLedger();
  const entities = uniqueById(state.entities ?? []).slice(0, MAX_ENTITIES);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const groups = sanitizeGroups(state.groups, entityIds);
  const anchors =
    state.version === 2
      ? (state.activeTemporalAnchors ?? [])
          .filter((anchor) => entityIds.size > 0 || Boolean(anchor.specId))
          .slice(0, MAX_INTERVALS)
          .map((anchor) => ({
            specId: String(anchor.specId).slice(0, 80),
            position: Math.max(0, Math.min(Number(anchor.position) || 0, 7)),
            interval: cloneInterval(anchor.interval),
          }))
      : anchorsFromV1Intervals(state.intervals ?? []);
  const frames =
    state.version === 2
      ? sanitizeFrames(state.frames ?? [], entityIds)
      : frameFromV1(state, entityIds, groups, anchors);
  const focusEntityIds = uniqueIds(state.focusEntityIds ?? [])
    .filter((id) => entityIds.has(id))
    .slice(0, MAX_ENTITIES);
  const effectiveFocus =
    focusEntityIds.length > 0
      ? focusEntityIds
      : frames.at(-1)?.entityIds ?? entities.slice(-1).map((entity) => entity.id);
  const checkpoint: ConversationLedgerCheckpoint = {
    revision: Math.max(0, Math.min(Number(state.revision) || 0, 10_000)),
    state: canonicalStateFromConversationState(
      state,
      entities,
      groups,
      frames,
      effectiveFocus,
      anchors
    ),
    knownEntities: entities,
    recentTurnIds: frames
      .map((frame) => frame.id.replace(/^frame:/, ""))
      .slice(-8),
    legacy: {
      explicitEntitySet: uniqueIds(state.explicitEntitySet ?? [])
        .filter((id) => entityIds.has(id))
        .slice(0, MAX_ENTITIES),
      criteria: uniqueIds(state.criteria ?? []).slice(0, 8),
      ...(state.horizon ? { horizon: state.horizon.slice(0, 120) } : {}),
      ...(state.jurisdiction
        ? { jurisdiction: state.jurisdiction.slice(0, 40) }
        : {}),
      ...(state.safetyRepliesUsed
        ? { safetyRepliesUsed: state.safetyRepliesUsed.slice(0, 24) }
        : {}),
      ...(state.pendingClarification
        ? { pendingClarification: state.pendingClarification.slice(0, 300) }
        : {}),
    },
  };
  return Object.freeze({
    version: 1 as const,
    entries: Object.freeze([]),
    checkpoint: Object.freeze(checkpoint),
  });
}

function projectedEntities(
  ledger: ConversationLedger,
  state: CanonicalLedgerState
): FinanceEntity[] {
  const candidates = uniqueById([
    ...(ledger.checkpoint?.knownEntities ?? []),
    ...ledger.entries.flatMap((entry) => entry.state.entities),
    ...state.entities,
  ]);
  const byId = new Map(candidates.map((entity) => [entity.id, entity]));
  const priorityIds = uniqueIds([
    ...(state.frames.at(-1)?.entityIds ?? []),
    ...state.focusEntityIds,
    ...state.entities.map((entity) => entity.id),
    ...[...state.frames]
      .reverse()
      .flatMap((frame) => frame.entityIds),
    ...candidates.map((entity) => entity.id),
  ]).slice(0, MAX_ENTITIES);
  return priorityIds
    .map((id) => byId.get(id))
    .filter((entity): entity is FinanceEntity => Boolean(entity));
}

/**
 * Projects the latest canonical ledger state to bounded wire state v2. The
 * optional previous state carries legacy-only UI fields across a greenfield
 * turn; semantic focus, frames, and anchors always come from the ledger.
 */
export function conversationStateFromLedger(
  ledger: ConversationLedger,
  previous?: ConversationState
): ConversationStateV2 {
  const state = ledger.entries.at(-1)?.state ?? ledger.checkpoint?.state;
  const revision =
    (ledger.checkpoint?.revision ?? 0) + ledger.entries.length;
  if (!state) {
    return {
      version: 2,
      revision,
      entities: [],
      explicitEntitySet: [],
      criteria: previous?.criteria.slice(0, 8) ?? [],
      focusEntityIds: [],
      frames: [],
      activeTemporalAnchors: [],
    };
  }
  const entities = projectedEntities(ledger, state);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const frames = sanitizeFrames(state.frames, entityIds);
  const frameIds = new Set(frames.flatMap((frame) => frame.entityIds));
  const focusEntityIds = uniqueIds(state.focusEntityIds)
    .filter((id) => entityIds.has(id))
    .slice(0, MAX_ENTITIES);
  const anchors = state.activeTemporalAnchors
    .slice(0, MAX_INTERVALS)
    .map((anchor) => ({
      ...anchor,
      interval: cloneInterval(anchor.interval),
    }));
  const intervals = anchors.map((anchor) => anchor.interval).slice(0, MAX_INTERVALS);
  const latestFrameGroupIds = frames.at(-1)
    ? new Set(frames.at(-1)?.groups.map((group) => group.id))
    : undefined;
  const groups = state.groups
    .filter(
      (group) =>
        !latestFrameGroupIds || latestFrameGroupIds.has(group.id)
    )
    .map((group) => ({
      id: group.id,
      label: group.label,
      memberIds: group.memberIds.filter((id) => entityIds.has(id)),
      namedAtRevision: revision,
    }))
    .filter((group) => group.memberIds.length > 0)
    .slice(-MAX_GROUPS);
  const legacy = ledger.checkpoint?.legacy;
  const explicitEntitySet = uniqueIds(
    frames.at(-1)?.entityIds ??
      (legacy?.explicitEntitySet as readonly string[] | undefined) ??
      previous?.explicitEntitySet ??
      []
  )
    .filter((id) => entityIds.has(id) && (frameIds.size === 0 || frameIds.has(id)))
    .slice(0, MAX_ENTITIES);
  return {
    version: 2,
    revision,
    entities,
    explicitEntitySet,
    criteria: uniqueIds(
      legacy?.criteria ?? previous?.criteria ?? []
    ).slice(0, 8),
    horizon:
      intervals.length > 0
        ? intervalsToHorizon(intervals)
        : legacy?.horizon ?? previous?.horizon,
    jurisdiction:
      state.entities.find((entity) => entity.jurisdiction)?.jurisdiction ??
      legacy?.jurisdiction ??
      previous?.jurisdiction,
    safetyRepliesUsed: [
      ...(legacy?.safetyRepliesUsed ?? previous?.safetyRepliesUsed ?? []),
    ].slice(0, 24),
    groups,
    focusEntityIds,
    intervals: intervals.length > 0 ? intervals : undefined,
    pendingClarification:
      legacy?.pendingClarification ?? previous?.pendingClarification,
    frames,
    activeTemporalAnchors: anchors,
  };
}

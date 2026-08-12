import { CANONICAL_GROUPS } from "./entity-catalog";
import { intervalsToHorizon, type TemporalInterval } from "./temporal";
import type {
  ConversationState,
  FinanceEntity,
  NamedGroupRef,
} from "./types";

const GROUP_IDS = new Set(CANONICAL_GROUPS.map((group) => group.id));
const SESSION = /^\d{4}-\d{2}-\d{2}$/;
const INTERVAL_KINDS = new Set([
  "session",
  "prior_session",
  "to_date",
  "trailing",
  "range",
]);

function sanitizeGroups(
  groups: NamedGroupRef[] | undefined,
  entityIds: Set<string>
): NamedGroupRef[] | undefined {
  const valid = (groups ?? [])
    .filter(
      (group) =>
        GROUP_IDS.has(group.id) &&
        typeof group.label === "string" &&
        group.label.length <= 80 &&
        Array.isArray(group.memberIds)
    )
    .map((group) => ({
      id: group.id,
      label: group.label.slice(0, 80),
      memberIds: group.memberIds.filter((id) => entityIds.has(id)).slice(0, 12),
      namedAtRevision: Math.max(
        0,
        Math.min(Number(group.namedAtRevision) || 0, 10_000)
      ),
    }))
    .filter((group) => group.memberIds.length > 0)
    .slice(-4);
  return valid.length > 0 ? valid : undefined;
}

function sanitizeIntervals(
  intervals: TemporalInterval[] | undefined
): TemporalInterval[] | undefined {
  const valid = (intervals ?? [])
    .filter(
      (value) =>
        value?.version === 1 &&
        typeof value.label === "string" &&
        value.label.length <= 60 &&
        INTERVAL_KINDS.has(value.kind) &&
        (value.calendar === "US" || value.calendar === "AU") &&
        SESSION.test(value.startSession) &&
        SESSION.test(value.endSession) &&
        value.startSession <= value.endSession
    )
    .map((value) => ({
      version: 1 as const,
      label: value.label,
      kind: value.kind,
      calendar: value.calendar,
      startSession: value.startSession,
      endSession: value.endSession,
      source:
        value.source === "explicit"
          ? ("explicit" as const)
          : value.source === "default"
            ? ("default" as const)
            : ("inherited" as const),
      ...(typeof value.raw === "string"
        ? { raw: value.raw.slice(0, 60) }
        : {}),
    }))
    .slice(0, 8);
  return valid.length > 0 ? valid : undefined;
}

const CRITERIA = new Set([
  "valuation",
  "performance",
  "dividends",
  "growth",
  "risk",
  "outlook",
  "earnings",
  "news",
  "size",
]);
const JURISDICTIONS = new Set([
  "Australia",
  "United States",
  "ASX",
  "London Stock Exchange",
  "Toronto Stock Exchange",
  "Hong Kong Stock Exchange",
  "Tokyo Stock Exchange",
  "National Stock Exchange of India",
  "Bombay Stock Exchange",
]);

export function sanitizeConversationState(
  previous: ConversationState,
  canonicalize: (entity: FinanceEntity) => FinanceEntity | null
): ConversationState {
  const entities = previous.entities
    .map(canonicalize)
    .filter((entity): entity is FinanceEntity => Boolean(entity))
    .slice(0, 12);
  const ids = new Set(entities.map((entity) => entity.id));
  const intervals = sanitizeIntervals(previous.intervals);
  return {
    version: 1,
    revision: Math.max(0, Math.min(previous.revision, 10_000)),
    entities,
    explicitEntitySet: [
      ...new Set(previous.explicitEntitySet.filter((id) => ids.has(id))),
    ].slice(0, 12),
    criteria: [
      ...new Set(previous.criteria.filter((criterion) => CRITERIA.has(criterion))),
    ].slice(0, 8),
    horizon: intervals ? intervalsToHorizon(intervals) : undefined,
    jurisdiction:
      previous.jurisdiction && JURISDICTIONS.has(previous.jurisdiction)
        ? previous.jurisdiction
        : undefined,
    safetyRepliesUsed: previous.safetyRepliesUsed
      ?.filter((id) => /^[a-z_]+:\d+$/.test(id))
      .slice(0, 24),
    groups: sanitizeGroups(previous.groups, ids),
    focusEntityIds: previous.focusEntityIds
      ?.filter((id) => ids.has(id))
      .slice(0, 12),
    intervals,
    pendingClarification:
      typeof previous.pendingClarification === "string"
        ? previous.pendingClarification.slice(0, 300)
        : undefined,
  };
}

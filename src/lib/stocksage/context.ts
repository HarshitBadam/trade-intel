import { detectCriteria } from "./conversation-attributes";
import { resolveConversationState, type StateResolution } from "./entities";
import { primaryCalendar } from "./listing-capability";
import {
  defaultInterval,
  intervalsToHorizon,
  parseIntervals,
} from "./temporal";
import type { ChatRequest, FinanceEntity, TurnContext } from "./types";

/**
 * Mirrors the entity view the domain policy has always been given: an explicit
 * conversation reference lets a bare follow-up inherit the prior subjects.
 */
export function hasExplicitConversationReference(message: string): boolean {
  return (
    /\b(?:it|its|that|they|their|them|those|these|both|former|latter|what about|how about|wb|which (?:one|is|looks)|all of them)\b/i.test(
      message
    ) ||
    /\b(?:a|the)\s+\w+(?:er)?\s+one(?:s)?\b/i.test(message) ||
    /^(?:(?:and|so|ok(?:ay)?)\s+)?(?:why|what (?:changed|happened|moved)|today|yesterday|(?:a\s+)?few days ago|anything notable|last (?:few days|week|month|quarter|year)|this (?:week|month|quarter|year))\b/i.test(
      message
    ) ||
    /\b(?:which developments?\b.*\bmatters?|what\b.*\bmatters?|catalysts?|what should (?:i|we|investors?) watch|summari[sz]e|recap|bottom line|trade-offs?)\b/i.test(
      message
    )
  );
}

/**
 * Builds the frozen conversational snapshot (message, entities, groups,
 * calendar, intervals, criteria, jurisdiction) from an already-resolved
 * conversation state. Kept separate from `resolveTurnContext` so the router's
 * few short-circuit branches (crisis, etc.) that never call
 * `resolveConversationState` can still produce a well-formed `TurnContext`.
 */
export function buildTurnContext(args: {
  message: string;
  resolution: StateResolution;
  entities: FinanceEntity[];
  now?: Date;
}): TurnContext {
  const { state } = args.resolution;
  const calendar = primaryCalendar(
    args.entities.length > 0 ? args.entities : state.entities
  );
  const intervals =
    state.intervals && state.intervals.length > 0
      ? state.intervals
      : [defaultInterval(calendar, args.now)];
  const contextState =
    state.intervals && state.intervals.length > 0
      ? state
      : {
          ...state,
          intervals,
          horizon: intervalsToHorizon(intervals),
        };
  const focusIds = new Set(contextState.focusEntityIds ?? []);
  const focusEntities = args.entities.filter((entity) =>
    focusIds.has(entity.id)
  );
  return Object.freeze({
    version: 1,
    message: args.message,
    state: contextState,
    entities: args.entities,
    focusEntities: focusEntities.length > 0 ? focusEntities : args.entities,
    groups: contextState.groups ?? [],
    intervals,
    calendar,
    criteria: contextState.criteria,
    jurisdiction: contextState.jurisdiction,
  } as TurnContext);
}

/**
 * The internal resolution metadata the router needs to make its policy and
 * routing decisions, alongside the frozen `TurnContext` it eventually
 * publishes. `resolveTurnContext` is the one place conversation entity,
 * group, listing, and temporal resolution happens for a turn; the router
 * never re-derives entities or calendars from raw text itself.
 */
export type TurnContextResolution = {
  context: TurnContext;
  resolution: StateResolution;
  /** Entities that should be treated as the active subject of this turn. */
  effectiveEntities: FinanceEntity[];
  /** Entities visible to domain policy evaluation for this turn. */
  policyEntities: FinanceEntity[];
  /** Whether the message referenced the prior conversation's subject(s). */
  conversationReference: boolean;
};

export function resolveTurnContext(args: {
  message: string;
  request: ChatRequest;
  now?: Date;
}): TurnContextResolution {
  const { message, request } = args;
  const resolution = resolveConversationState(
    message,
    request.state,
    request.history
  );
  // A bare follow-up that names only a time window ("and over the last
  // month?") or only a criterion ("what risks should I research first?")
  // continues the active subject rather than leaving the finance domain.
  const carriesFollowUpAttribute =
    resolution.entities.length === 0 &&
    resolution.state.entities.length > 0 &&
    (parseIntervals({
      message,
      calendar: primaryCalendar(resolution.state.entities),
      now: args.now,
    }).length > 0 ||
      detectCriteria(message).length > 0);
  const conversationReference =
    hasExplicitConversationReference(message) || carriesFollowUpAttribute;
  const effectiveEntities =
    resolution.entities.length > 0
      ? resolution.entities
      : conversationReference
        ? resolution.state.entities
        : [];
  const policyEntities =
    resolution.entities.length > 0
      ? resolution.entities
      : resolution.state.entities.length > 0
        ? resolution.state.entities
        : [];
  const context = buildTurnContext({
    message,
    resolution,
    entities: effectiveEntities,
    now: args.now,
  });
  return {
    context,
    resolution,
    effectiveEntities,
    policyEntities,
    conversationReference,
  };
}

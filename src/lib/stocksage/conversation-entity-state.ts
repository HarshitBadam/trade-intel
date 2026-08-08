import {
  CANONICAL_GROUPS,
  WEB_ALIASES,
  type CanonicalGroup,
  type WebAlias,
} from "./entity-catalog";
import { detectCriteria, detectHorizon, detectJurisdiction } from "./conversation-attributes";
import {
  canonicalizeEntity,
  fromAlias,
  groupMembers,
  resolveGroupRefs,
  resolveText,
} from "./entity-resolution";
import { primaryCalendar } from "./listing-capability";
import { sanitizeConversationState } from "./state";
import {
  intervalsToHorizon,
  mergeContrastIntervals,
  parseIntervals,
  type TemporalInterval,
} from "./temporal";
import type {
  ChatTurn,
  ConversationState,
  FinanceEntity,
  NamedGroupRef,
} from "./types";
import {
  AUSTRALIAN_BANK_TICKERS,
  CATEGORY_REFERENCE,
  COMPARISON_FOLLOW_UP,
  CONSULTING_NAMES,
  CONTEXTUAL_FOLLOW_UP,
  NARROWING_TO_SUBSET,
  ORDERED_REFERENCE,
  PLURAL_REFERENCE,
  REMOVAL,
  RESET,
  SINGULAR_REFERENCE,
  SWAP_CORRECTION,
  SWAP_IN_CORRECTION,
  isIndexEntity,
  lastAssistantMentionCounts,
  normalizeOrderedReference,
  normalizeStateCommand,
  removalTargets,
  subsetKeepCount,
} from "./entity-state-helpers";
export function emptyConversationState(): ConversationState {
  return {
    version: 1,
    revision: 0,
    entities: [],
    explicitEntitySet: [],
    criteria: [],
  };
}
export function baseConversationState(
  previous: ConversationState | undefined,
  history: ChatTurn[]
): ConversationState {
  return previous
    ? sanitizeConversationState(previous, canonicalizeEntity)
    : stateFromHistory(history);
}
function stateFromHistory(history: ChatTurn[]): ConversationState {
  let state = emptyConversationState();
  for (const turn of history) {
    if (turn.role !== "user") continue;
    const entities = [
      ...resolveText(turn.text),
      ...groupMembers(resolveGroupRefs(turn.text)),
    ];
    if (entities.length === 0) continue;
    const unique = [...new Map(entities.map((entity) => [entity.id, entity])).values()];
    state = {
      ...state,
      revision: state.revision + 1,
      entities: unique,
      explicitEntitySet: unique.map((entity) => entity.id),
    };
  }
  return state;
}
export type StateResolution = {
  state: ConversationState;
  entities: FinanceEntity[];
  clarification?: string;
  reasonCode: string;
};
export function resolveConversationState(
  message: string,
  previous: ConversationState | undefined,
  history: ChatTurn[] = []
): StateResolution {
  const base = previous
    ? sanitizeConversationState(previous, canonicalizeEntity)
    : stateFromHistory(history);
  const commandMessage = normalizeOrderedReference(
    normalizeStateCommand(message),
    base.explicitEntitySet.length === 2
  );
  if (RESET.test(commandMessage)) {
    return {
      state: { ...emptyConversationState(), revision: base.revision + 1 },
      entities: [],
      reasonCode: "state_reset",
    };
  }
  let direct = resolveText(message);
  const fortuneReplacement =
    /\b(?:wb|what about)\s+(?:the\s+)?100\b/i.test(message) &&
    base.entities.some((entity) => entity.name === "Fortune 500");
  if (fortuneReplacement) {
    const fortune100 = WEB_ALIASES.find((alias) => alias.name === "Fortune 100");
    direct = fortune100 ? [fromAlias(fortune100)] : direct;
  }
  const meantCorrection = message.match(
    /\bi meant\s+(.+?)(?:,|\s)\s*not\s+(.+?)(?:[.!?]|$)/i
  );
  const replacementCorrection = message.match(
    /\bnot\s+(.+?)(?:,|\s+but\s+|\s+instead\s+)(.+?)(?:[.!?]|$)/i
  );
  const swapIn = commandMessage.match(SWAP_IN_CORRECTION);
  const swap = swapIn ? null : commandMessage.match(SWAP_CORRECTION);
  let removed = meantCorrection
    ? resolveText(meantCorrection[2])
    : replacementCorrection
      ? resolveText(replacementCorrection[1])
      : swapIn
        ? resolveText(swapIn[2])
        : swap
          ? resolveText(swap[1])
          : [];
  if (removed.length === 0) {
    const removalMatch = commandMessage.match(REMOVAL);
    if (removalMatch) {
      removed = removalTargets(removalMatch[1], base.entities);
    }
  }
  if (
    removed.length === 0 &&
    base.entities.length > 2 &&
    NARROWING_TO_SUBSET.test(commandMessage)
  ) {
    const counts = lastAssistantMentionCounts(base.entities, history);
    const mentioned = base.entities.filter(
      (entity) => (counts.get(entity.id) ?? 0) > 0
    );
    if (mentioned.length > 0 && mentioned.length < base.entities.length) {
      const keepCount = Math.min(subsetKeepCount(message), mentioned.length);
      const keepIds = new Set(
        [...mentioned]
          .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
          .slice(0, keepCount)
          .map((entity) => entity.id)
      );
      removed = base.entities.filter((entity) => !keepIds.has(entity.id));
    }
  }
  // Listing clarifications such as "I mean ASX:MQG, not Macquarie" can resolve
  // both sides to the same canonical company. Treat that as a clarification,
  // not as deleting the company from conversation state.
  if (
    removed.length > 0 &&
    direct.length > 0 &&
    direct.every((entity) =>
      removed.some((candidate) => candidate.id === entity.id)
    )
  ) {
    removed = [];
  }
  let correctedBase = base.entities;
  let correctedExplicitSet = base.explicitEntitySet;
  if (removed.length > 0) {
    const removedIds = new Set(removed.map((entity) => entity.id));
    direct = direct.filter((entity) => !removedIds.has(entity.id));
    const insertionIndex = base.entities.findIndex((entity) =>
      removedIds.has(entity.id)
    );
    correctedBase = base.entities.filter(
      (entity) => !removedIds.has(entity.id)
    );
    correctedBase.splice(
      insertionIndex >= 0 ? insertionIndex : correctedBase.length,
      0,
      ...direct
    );
    correctedBase = [
      ...new Map(correctedBase.map((entity) => [entity.id, entity])).values(),
    ];
    const replacementIds = direct.map((entity) => entity.id);
    correctedExplicitSet = [
      ...new Set(
        base.explicitEntitySet.flatMap((id) =>
          removedIds.has(id) ? replacementIds : [id]
        )
      ),
    ];
  }
  const namedGroupRefs = resolveGroupRefs(message);
  let grouped = groupMembers(namedGroupRefs);
  let namedGroups: CanonicalGroup[] = [...namedGroupRefs];
  let groupSwitch = false;
  if (
    grouped.length === 0 &&
    /\b(?:other|another)\s+big\s*(?:4|four)\b/i.test(message)
  ) {
    const hasAustralian = base.entities.some(
      (entity) => entity.ticker && AUSTRALIAN_BANK_TICKERS.has(entity.ticker)
    );
    const hasConsulting = base.entities.some((entity) =>
      CONSULTING_NAMES.has(entity.name)
    );
    const target = hasAustralian
      ? CANONICAL_GROUPS.find(
          (candidate) => candidate.id === "professional-services-big-four"
        )
      : hasConsulting
        ? CANONICAL_GROUPS.find(
            (candidate) => candidate.id === "australian-big-four"
          )
        : undefined;
    if (target) {
      groupSwitch = true;
      namedGroups = [target];
      grouped = target.members
        .map((member) =>
          WEB_ALIASES.find(
            (alias) => alias.ticker === member || alias.name === member
          )
        )
        .filter((alias): alias is WebAlias => Boolean(alias))
        .map(fromAlias);
    }
  }
  const byId = new Map(base.entities.map((entity) => [entity.id, entity]));
  const subsetMatch = commandMessage.match(
    /\b(?:only\s+)?the\s+(former|latter)\s+two\b/i
  );
  const orderedMatches = [
    ...commandMessage.matchAll(/\b(former|latter|first one|second one)\b/gi),
  ];
  const orderedMatch = orderedMatches[0];
  let orderedPivot = false;
  if (subsetMatch) {
    if (base.explicitEntitySet.length < 2) {
      return {
        state: base,
        entities: [],
        clarification:
          "Which companies do you mean? Name the group before asking for a subset.",
        reasonCode: "ambiguous_ordered_reference",
      };
    }
    const useFormer = /former/i.test(subsetMatch[1]);
    const ids = useFormer
      ? base.explicitEntitySet.slice(0, 2)
      : base.explicitEntitySet.slice(-2);
    direct.unshift(
      ...ids
        .map((id) => byId.get(id))
        .filter((entity): entity is FinanceEntity => Boolean(entity))
    );
  } else if (orderedMatch) {
    if (base.explicitEntitySet.length !== 2) {
      return {
        state: base,
        entities: [],
        clarification:
          "Which two entities do you mean? Name them in order so I can resolve former and latter.",
        reasonCode: "ambiguous_ordered_reference",
      };
    }
    const ids = [
      ...new Set(
        orderedMatches.map((match) =>
          /former|first/i.test(match[1])
            ? base.explicitEntitySet[0]
            : base.explicitEntitySet[1]
        )
      ),
    ];
    const resolved = ids
      .map((id) => byId.get(id))
      .filter((entity): entity is FinanceEntity => Boolean(entity));
    if (resolved.length !== ids.length) {
      return {
        state: base,
        entities: [],
        clarification: "Please name the entity you mean.",
        reasonCode: "stale_ordered_reference",
      };
    }
    orderedPivot = direct.length > 0;
    direct.unshift(...resolved);
  }
  const referencesPlural =
    PLURAL_REFERENCE.test(message) || CATEGORY_REFERENCE.test(message);
  const referencesSingular = SINGULAR_REFERENCE.test(message);
  const anchoredPronoun =
    /\b(?:its|that one|this one|the company|the stock|the shares)\b/i.test(
      message
    ) ||
    (/\b(?:compare[ds]?|comparing|vs\.?|versus|against|beat(?:s|ing)?|stacks? up|match(?:es)? up)\b/i.test(
      message
    ) &&
      /\bit\b/i.test(message));
  const bareComparison =
    /^(?:(?:and|or|ok(?:ay)?|so|now)\s+)?(?:vs\.?|versus|against|compared?\s+(?:to|with))\b/i.test(
      message
    );
  const anchor =
    direct.length > 0 &&
    grouped.length === 0 &&
    removed.length === 0 &&
    !subsetMatch &&
    !orderedMatch &&
    !fortuneReplacement &&
    (anchoredPronoun || bareComparison)
      ? base.entities
          .slice(-1)
          .filter(
            (entity) => !direct.some((candidate) => candidate.id === entity.id)
          )
      : [];
  const indexReference =
    removed.length === 0 &&
    /\bthe\s+(?:index(?:es)?|indices|benchmark)\b/i.test(message) &&
    ![...direct, ...grouped].some(isIndexEntity)
      ? base.entities.filter(isIndexEntity)
      : [];
  const priorGroups = base.groups ?? [];
  const priorGroupMemberIds = new Set(
    priorGroups.flatMap((group) => group.memberIds)
  );
  const priorGroupEntities = base.entities.filter((entity) =>
    priorGroupMemberIds.has(entity.id)
  );
  /**
   * "Them" after "Macquarie vs the Aussie Big Four" means the named group, not
   * the whole prior comparison. When every active entity already belongs to a
   * named group the two readings coincide.
   */
  const pluralReferent =
    priorGroupEntities.length > 0 &&
    priorGroupEntities.length < base.entities.length
      ? priorGroupEntities
      : base.entities;
  const priorFocus =
    base.focusEntityIds && base.focusEntityIds.length > 0
      ? base.entities.filter((entity) =>
          base.focusEntityIds?.includes(entity.id)
        )
      : base.entities.slice(-1);
  const comparisonFollowUp =
    !orderedMatch &&
    !subsetMatch &&
    direct.length === 0 &&
    grouped.length === 0 &&
    base.explicitEntitySet.length >= 2 &&
    COMPARISON_FOLLOW_UP.test(message);
  const contextualFollowUp =
    direct.length === 0 &&
    grouped.length === 0 &&
    base.entities.length > 0 &&
    CONTEXTUAL_FOLLOW_UP.test(message);
  const carriesForward =
    removed.length === 0 &&
    !subsetMatch &&
    !orderedMatch &&
    !fortuneReplacement &&
    base.entities.length > 0;
  /** "It" beside a newly named group keeps the prior focus in the comparison. */
  const singularAnchorWithGroup =
    carriesForward &&
    referencesSingular &&
    direct.length === 0 &&
    grouped.length > 0 &&
    anchoredPronoun;
  /**
   * "Them vs IXIC" keeps the prior group beside the newly named entity. The
   * pronoun has to be the subject of the comparison; a trailing "trust them"
   * inside a sentence about a new company is not a reference to prior state.
   */
  const pluralComparisonSubject =
    /^(?:(?:and|so|ok(?:ay)?|now|then|what about|how about|wb)\s+)?(?:them|those|these|they|both)\b[^.!?]{0,24}?\b(?:vs\.?|versus|against|compared?\s+(?:to|with))\b/i.test(
      message
    ) ||
    /\b(?:compare|compared|comparing)\s+(?:them|those|these|both)\b/i.test(
      message
    );
  const pluralAnchor =
    carriesForward &&
    referencesPlural &&
    direct.length > 0 &&
    pluralComparisonSubject;
  const referenced =
    removed.length > 0
      ? correctedBase
      : comparisonFollowUp ||
          contextualFollowUp ||
          (referencesPlural && direct.length === 0) ||
          pluralAnchor ||
          singularAnchorWithGroup ||
          (referencesSingular &&
            direct.length === 0 &&
            grouped.length === 0)
        ? referencesSingular && !pluralAnchor
          ? comparisonFollowUp
            ? referencesPlural
              ? pluralReferent
              : base.entities
            : singularAnchorWithGroup
              ? priorFocus
              : base.entities.slice(-1)
          : pluralReferent
        : [];
  const merged = fortuneReplacement
    ? base.entities.flatMap((entity) =>
        entity.name === "Fortune 500" ? direct : [entity]
      )
    : [...referenced, ...anchor, ...direct, ...grouped, ...indexReference];
  const entities = [
    ...new Map(merged.map((entity) => [entity.id, entity])).values(),
  ].slice(0, 12);
  const explicit = [...anchor, ...direct, ...grouped, ...indexReference];
  const retainComparisonContext =
    (Boolean(orderedMatch) && !subsetMatch && !orderedPivot) ||
    (direct.length === 0 &&
      grouped.length === 0 &&
      removed.length === 0 &&
      !fortuneReplacement);
  const criteria = detectCriteria(message);
  const startsNewTopic =
    (direct.length > 0 || (grouped.length > 0 && !groupSwitch)) &&
    anchor.length === 0 &&
    indexReference.length === 0 &&
    !orderedMatch &&
    !subsetMatch &&
    removed.length === 0 &&
    !fortuneReplacement;
  const horizon = detectHorizon(message);
  const jurisdiction = detectJurisdiction(message, entities);
  const activeEntities = retainComparisonContext
    ? base.entities
    : removed.length > 0 || entities.length > 0
      ? entities
      : base.entities;
  const activeIds = new Set(activeEntities.map((entity) => entity.id));
  const revision = base.revision + 1;
  const freshGroups: NamedGroupRef[] = namedGroups.map((group) => ({
    id: group.id,
    label: group.label,
    memberIds: groupMembers([group])
      .map((entity) => entity.id)
      .filter((id) => activeIds.has(id)),
    namedAtRevision: revision,
  }));
  const freshGroupIds = new Set(freshGroups.map((group) => group.id));
  const carriedGroups = priorGroups
    .filter((group) => !freshGroupIds.has(group.id))
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((id) => activeIds.has(id)),
    }));
  const groups = [...carriedGroups, ...freshGroups]
    .filter((group) => group.memberIds.length > 0)
    .slice(-4);
  const explicitIds = [...new Set(explicit.map((entity) => entity.id))].filter(
    (id) => activeIds.has(id)
  );
  const focusEntityIds =
    explicitIds.length > 0
      ? explicitIds
      : activeEntities.map((entity) => entity.id);
  const calendar = primaryCalendar(
    activeEntities.length > 0 ? activeEntities : base.entities
  );
  const parsedIntervals = parseIntervals({ message, calendar });
  const intervals: TemporalInterval[] = mergeContrastIntervals({
    message,
    previous: startsNewTopic ? [] : (base.intervals ?? []),
    parsed: parsedIntervals,
  });
  const next: ConversationState = {
    version: 1,
    revision,
    entities: retainComparisonContext
      ? base.entities
      : removed.length > 0 || entities.length > 0
        ? entities
        : base.entities,
    explicitEntitySet:
      removed.length > 0
        ? correctedExplicitSet
        : fortuneReplacement
          ? base.explicitEntitySet.flatMap((id) =>
              base.entities.find((entity) => entity.id === id)?.name ===
              "Fortune 500"
                ? direct.map((entity) => entity.id)
                : [id]
            )
          : orderedMatch && !subsetMatch
            ? orderedPivot
              ? [...new Set(explicit.map((entity) => entity.id))]
              : base.explicitEntitySet
            : subsetMatch
              ? [...new Set(direct.map((entity) => entity.id))]
              : explicit.length > 0
                ? [...new Set(explicit.map((entity) => entity.id))]
                : base.explicitEntitySet,
    criteria:
      criteria.length > 0 ? criteria : startsNewTopic ? [] : base.criteria,
    horizon:
      intervalsToHorizon(intervals) ??
      horizon ??
      (startsNewTopic ? undefined : base.horizon),
    jurisdiction:
      jurisdiction ?? (startsNewTopic ? undefined : base.jurisdiction),
    safetyRepliesUsed: base.safetyRepliesUsed,
    ...(groups.length > 0 ? { groups } : {}),
    ...(focusEntityIds.length > 0 ? { focusEntityIds } : {}),
    ...(intervals.length > 0 ? { intervals } : {}),
  };
  return {
    state: next,
    entities,
    reasonCode:
      removed.length > 0
        ? "entity_correction"
        : grouped.length > 0
          ? "canonical_group_expanded"
          : ORDERED_REFERENCE.test(commandMessage)
            ? "ordered_reference_resolved"
            : anchor.length > 0
              ? "anchored_reference_resolved"
              : referencesPlural || referencesSingular
                ? "conversation_reference_resolved"
                : direct.length > 0
                  ? "explicit_entities"
                  : "no_entities",
  };
}

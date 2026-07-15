import {
  CANONICAL_GROUPS,
  WEB_ALIASES,
  type WebAlias,
} from "./entity-catalog";
import {
  detectCriteria,
  detectHorizon,
  detectJurisdiction,
} from "./conversation-attributes";
import {
  canonicalizeEntity,
  fromAlias,
  resolveGroup,
  resolveText,
} from "./entity-resolution";
import { sanitizeConversationState } from "./state";
import type {
  ChatTurn,
  ConversationState,
  FinanceEntity,
} from "./types";

const PLURAL_REFERENCE = /\b(?:they|their|them|those|these|both)\b/i;
// Conversational category references ("the consultant group") should
// inherit whichever named group is currently active, same as "they".
const CATEGORY_REFERENCE =
  /\b(?:the\s+consultant(?:s|ing)?(?:\s+group)?|the\s+consulting\s+firms?|the\s+accounting\s+firms?)\b/i;
const SINGULAR_REFERENCE =
  /\b(?:it|its|that one|this one|the company|the stock|the shares|what about|how about|wb)\b/i;
const ORDERED_REFERENCE = /\b(?:former|latter|first one|second one)\b/i;
const COMPARISON_FOLLOW_UP =
  /\b(?:which (?:one|is|looks)|which of (?:the|those|these)|what about|how about|wb|better|safe(?:st|r)|less risky|more risky|more volatile|volatil|rank|order|all of them|former two|latter two|today|yesterday|(?:a\s+)?few days ago|last (?:few days|week|month|quarter|year)|this (?:week|month|quarter|year)|over (?:the )?last|past \d+|between)\b/i;
const CONTEXTUAL_FOLLOW_UP =
  /^(?:(?:and|so|ok(?:ay)?|\.{2,})\s+)?(?:today|yesterday|(?:a\s+)?few days ago|anything notable|last (?:few days|week|month|quarter|year)|this (?:week|month|quarter|year)|what (?:changed|happened|moved)|what(?:'?s| is) (?:your|the) (?:current\s+)?outlook|which (?:one|is|looks|parts?)|(?:can you )?reconcile|how (?:did|has|is|are|was)|why\b|rank\b|order\b|all of them\b|only the (?:former|latter) two\b)/i;
const REMOVAL =
  /\b(?:forget|drop|remove|ignore|skip|leave out|without)\s+(?:about\s+)?(.+?)(?=\s*(?:[—–-]{1,2}|,|\.|;|!|\?|$))/i;
// "swap X out for Y" / "replace X with Y" is a targeted substitution: X
// leaves, Y takes X's slot, and everything else in the active set stays
// (the FQ swap-correction hard fail: Nasdaq must survive the Tesla→Rivian
// swap). "swap in Y for X" reverses which capture names the outgoing one.
const SWAP_IN_CORRECTION =
  /\b(?:swap|sub(?:stitute)?)\s+in\s+(.+?)\s+(?:for|instead of|in place of)\s+(.+?)(?=[.!?,;]|$)/i;
const SWAP_CORRECTION =
  /\b(?:swap|switch|replace|sub(?:stitute)?)\s+(?:out\s+)?(.+?)\s+(?:out\s+)?(?:for|with|to)\s+(.+?)(?=[.!?,;]|$)/i;
// "Forget the others, between those two..." names no specific entity, so it
// cannot resolve via REMOVAL above — it narrows to whichever subset the
// assistant's own last reply most recently focused on (FQ-08/F1.2).
const NARROWING_TO_SUBSET =
  /\b(?:forget\s+(?:the\s+)?(?:others?|rest)|only\s+(?:those|these)\s+(?:two|three|four|couple)|between\s+(?:those|these)\s+(?:two|three|couple)|just\s+(?:those|these)\s+(?:two|three))\b/i;
const RESET = /^(?:reset|start (?:over|fresh|again)|clear (?:the )?(?:context|conversation|slate)|new topic)[\s,.!?]*$/i;
const AUSTRALIAN_BANK_TICKERS = new Set(["CBA", "NAB", "ANZ", "WBC"]);
const CONSULTING_NAMES = new Set(["Deloitte", "PwC", "EY", "KPMG"]);
const INDEX_TICKERS = new Set(["IXIC", "GSPC", "DJI"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function subsetKeepCount(message: string): number {
  const match = message.match(/\b(two|three|four|couple)\b/i);
  const word = match?.[1].toLowerCase();
  if (word === "three") return 3;
  if (word === "four") return 4;
  return 2;
}

// Counts name/ticker mentions of each currently-known entity in the most
// recent assistant turn, so "those two"/"the others" can resolve against
// whichever subset the assistant itself just highlighted rather than the
// full original explicit set.
function lastAssistantMentionCounts(
  base: FinanceEntity[],
  history: ChatTurn[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn.role !== "ai") continue;
    for (const entity of base) {
      const terms = [
        entity.ticker,
        entity.name,
        entity.name.split(/[\s,.]+/)[0],
      ].filter(
        (term): term is string => typeof term === "string" && term.length >= 2
      );
      let count = 0;
      for (const term of new Set(terms)) {
        const matches = turn.text.match(
          new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi")
        );
        count += matches?.length ?? 0;
      }
      counts.set(entity.id, count);
    }
    return counts;
  }
  return counts;
}

function isIndexEntity(entity: FinanceEntity): boolean {
  return (
    (Boolean(entity.ticker) && INDEX_TICKERS.has(entity.ticker as string)) ||
    /\b(?:composite|index|500)\b/i.test(entity.name)
  );
}

function removalTargets(
  phrase: string,
  base: FinanceEntity[]
): FinanceEntity[] {
  const resolved = resolveText(phrase);
  if (resolved.length > 0) return resolved;
  if (/\b(?:index(?:es)?|indices)\b/i.test(phrase)) {
    return base.filter(isIndexEntity);
  }
  if (/\bbanks?\b/i.test(phrase)) {
    return base.filter(
      (entity) => entity.ticker && AUSTRALIAN_BANK_TICKERS.has(entity.ticker)
    );
  }
  if (/\bconsult|accountants?|firms\b/i.test(phrase)) {
    return base.filter((entity) => CONSULTING_NAMES.has(entity.name));
  }
  if (/\b(?:those|these|them|others?|rest)\b/i.test(phrase)) {
    return base;
  }
  return [];
}

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
    const entities = [...resolveText(turn.text), ...resolveGroup(turn.text)];
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
  if (RESET.test(message)) {
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
  const swapIn = message.match(SWAP_IN_CORRECTION);
  const swap = swapIn ? null : message.match(SWAP_CORRECTION);
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
    const removalMatch = message.match(REMOVAL);
    if (removalMatch) {
      removed = removalTargets(removalMatch[1], base.entities);
    }
  }
  if (
    removed.length === 0 &&
    base.entities.length > 2 &&
    NARROWING_TO_SUBSET.test(message)
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
  let grouped = resolveGroup(message);
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
  const subsetMatch = message.match(
    /\b(?:only\s+)?the\s+(former|latter)\s+two\b/i
  );
  const orderedMatches = [
    ...message.matchAll(/\b(former|latter|first one|second one)\b/gi),
  ];
  const orderedMatch = orderedMatches[0];
  // True when an ordered reference ("the former") is paired with a newly
  // named entity in the same message ("... vs IXIC"), meaning the user is
  // deliberately pivoting the active comparison pair rather than just
  // re-referring to the existing one (F1.1/FQ-02).
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
  // A message that IS the comparison connector ("vs amd", "against the S&P")
  // names only the new side; the old side is whatever was just discussed.
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
  // "is it beating the index" re-attaches whichever index is already in
  // play, even when this turn also names a company explicitly.
  const indexReference =
    removed.length === 0 &&
    /\bthe\s+(?:index(?:es)?|indices|benchmark)\b/i.test(message) &&
    ![...direct, ...grouped].some(isIndexEntity)
      ? base.entities.filter(isIndexEntity)
      : [];
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
  const referenced =
    removed.length > 0
      ? correctedBase
      : comparisonFollowUp ||
          contextualFollowUp ||
          referencesPlural ||
          (referencesSingular &&
            direct.length === 0 &&
            grouped.length === 0)
      ? referencesSingular
        ? comparisonFollowUp
          ? base.entities
          : base.entities.slice(-1)
        : base.entities
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
  const next: ConversationState = {
    version: 1,
    revision: base.revision + 1,
    // After a removal, the corrected set stands even when it came out empty
    // ("forget the consultants" must not silently keep the consultants).
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
    horizon: horizon ?? (startsNewTopic ? undefined : base.horizon),
    jurisdiction:
      jurisdiction ?? (startsNewTopic ? undefined : base.jurisdiction),
    // Safety-reply bookkeeping is session-scoped, not topic-scoped: a new
    // topic must not license replaying a refusal the user already read.
    safetyRepliesUsed: base.safetyRepliesUsed,
  };
  return {
    state: next,
    entities,
    reasonCode:
      removed.length > 0
        ? "entity_correction"
        : grouped.length > 0
          ? "canonical_group_expanded"
          : ORDERED_REFERENCE.test(message)
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

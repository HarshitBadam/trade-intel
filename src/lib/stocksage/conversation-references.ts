import {
  CATEGORY_REFERENCE,
  COMPARISON_FOLLOW_UP,
  CONTEXTUAL_FOLLOW_UP,
  PLURAL_REFERENCE,
  SINGULAR_REFERENCE,
  isIndexEntity,
} from "./entity-state-helpers";
import type { TemporalResolution } from "./temporal-types";
import type { ConversationState, FinanceEntity } from "./types";

export type ReferenceAnchors = {
  referencesPlural: boolean;
  referencesSingular: boolean;
  anchoredPronoun: boolean;
  anchor: FinanceEntity[];
  indexReference: FinanceEntity[];
  pluralReferent: FinanceEntity[];
  priorFocus: FinanceEntity[];
};

export function identifyReferenceAnchors(args: {
  message: string;
  base: ConversationState;
  direct: FinanceEntity[];
  grouped: FinanceEntity[];
  removed: FinanceEntity[];
  subsetMatch: boolean;
  orderedMatch: boolean;
  fortuneReplacement: boolean;
}): ReferenceAnchors {
  const {
    message,
    base,
    direct,
    grouped,
    removed,
    subsetMatch,
    orderedMatch,
    fortuneReplacement,
  } = args;
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

  const priorGroupMemberIds = new Set(
    (base.groups ?? []).flatMap((group) => group.memberIds)
  );
  const priorGroupEntities = base.entities.filter((entity) =>
    priorGroupMemberIds.has(entity.id)
  );
  // A plural pronoun targets a named subgroup when the active set also has peers.
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

  return {
    referencesPlural,
    referencesSingular,
    anchoredPronoun,
    anchor,
    indexReference,
    pluralReferent,
    priorFocus,
  };
}

export type EntityReferenceResolution = {
  entities: FinanceEntity[];
  explicit: FinanceEntity[];
  retainComparisonContext: boolean;
  startsNewTopic: boolean;
};

export function resolveEntityReferences(args: {
  message: string;
  base: ConversationState;
  direct: FinanceEntity[];
  grouped: FinanceEntity[];
  removed: FinanceEntity[];
  correctedBase: FinanceEntity[];
  subsetMatch: boolean;
  orderedMatch: boolean;
  orderedPivot: boolean;
  fortuneReplacement: boolean;
  groupSwitch: boolean;
  temporal: TemporalResolution;
  anchors: ReferenceAnchors;
}): EntityReferenceResolution {
  const {
    message,
    base,
    direct,
    grouped,
    removed,
    correctedBase,
    subsetMatch,
    orderedMatch,
    orderedPivot,
    fortuneReplacement,
    groupSwitch,
    temporal,
    anchors,
  } = args;
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
    (CONTEXTUAL_FOLLOW_UP.test(message) || temporal.status === "resolved");
  const carriesForward =
    removed.length === 0 &&
    !subsetMatch &&
    !orderedMatch &&
    !fortuneReplacement &&
    base.entities.length > 0;
  // A singular pronoun beside a new group keeps the prior focus as its peer.
  const singularAnchorWithGroup =
    carriesForward &&
    anchors.referencesSingular &&
    direct.length === 0 &&
    grouped.length > 0 &&
    anchors.anchoredPronoun;
  // A plural pronoun carries state only when it is the comparison subject.
  const pluralComparisonSubject =
    /^(?:(?:and|so|ok(?:ay)?|now|then|what about|how about|wb)\s+)?(?:them|those|these|they|both)\b[^.!?]{0,24}?\b(?:vs\.?|versus|against|compared?\s+(?:to|with))\b/i.test(
      message
    ) ||
    /\b(?:compare|compared|comparing)\s+(?:them|those|these|both)\b/i.test(
      message
    );
  const pluralAnchor =
    carriesForward &&
    anchors.referencesPlural &&
    direct.length > 0 &&
    pluralComparisonSubject;
  const referenced =
    removed.length > 0
      ? correctedBase
      : comparisonFollowUp ||
          contextualFollowUp ||
          (anchors.referencesPlural && direct.length === 0) ||
          pluralAnchor ||
          singularAnchorWithGroup ||
          (anchors.referencesSingular &&
            direct.length === 0 &&
            grouped.length === 0)
        ? anchors.referencesSingular && !pluralAnchor
          ? comparisonFollowUp
            ? anchors.referencesPlural
              ? anchors.pluralReferent
              : base.entities
            : singularAnchorWithGroup
              ? anchors.priorFocus
              : base.entities.slice(-1)
          : anchors.pluralReferent
        : [];
  const merged = fortuneReplacement
    ? base.entities.flatMap((entity) =>
        entity.name === "Fortune 500" ? direct : [entity]
      )
    : [
        ...referenced,
        ...anchors.anchor,
        ...direct,
        ...grouped,
        ...anchors.indexReference,
      ];
  const entities = [
    ...new Map(merged.map((entity) => [entity.id, entity])).values(),
  ].slice(0, 12);
  const explicit = [
    ...anchors.anchor,
    ...direct,
    ...grouped,
    ...anchors.indexReference,
  ];
  const retainComparisonContext =
    (orderedMatch && !subsetMatch && !orderedPivot) ||
    (direct.length === 0 &&
      grouped.length === 0 &&
      removed.length === 0 &&
      !fortuneReplacement);
  const startsNewTopic =
    (direct.length > 0 || (grouped.length > 0 && !groupSwitch)) &&
    anchors.anchor.length === 0 &&
    anchors.indexReference.length === 0 &&
    !orderedMatch &&
    !subsetMatch &&
    removed.length === 0 &&
    !fortuneReplacement;

  return { entities, explicit, retainComparisonContext, startsNewTopic };
}

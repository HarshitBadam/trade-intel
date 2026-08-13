import {
  CANONICAL_GROUPS,
  WEB_ALIASES,
  type CanonicalGroup,
  type WebAlias,
} from "../entity/entity-catalog";
import { fromAlias, groupMembers, resolveGroupRefs } from "../entity/entity-resolution";
import {
  AUSTRALIAN_BANK_TICKERS,
  CONSULTING_NAMES,
} from "../entity/entity-state-helpers";
import type { FinanceEntity, NamedGroupRef } from "../types";

export type ConversationGroupResolution = {
  grouped: FinanceEntity[];
  namedGroups: CanonicalGroup[];
  groupSwitch: boolean;
};

export function resolveConversationGroups(
  message: string,
  baseEntities: FinanceEntity[]
): ConversationGroupResolution {
  const namedGroupRefs = resolveGroupRefs(message);
  let grouped = groupMembers(namedGroupRefs);
  let namedGroups: CanonicalGroup[] = [...namedGroupRefs];
  let groupSwitch = false;

  if (
    grouped.length === 0 &&
    /\b(?:other|another)\s+big\s*(?:4|four)\b/i.test(message)
  ) {
    const hasAustralian = baseEntities.some(
      (entity) => entity.ticker && AUSTRALIAN_BANK_TICKERS.has(entity.ticker)
    );
    const hasConsulting = baseEntities.some((entity) =>
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

  return { grouped, namedGroups, groupSwitch };
}

export function updateConversationGroups(args: {
  priorGroups: NamedGroupRef[];
  namedGroups: CanonicalGroup[];
  activeEntities: FinanceEntity[];
  revision: number;
}): NamedGroupRef[] {
  const activeIds = new Set(args.activeEntities.map((entity) => entity.id));
  const freshGroups: NamedGroupRef[] = args.namedGroups.map((group) => ({
    id: group.id,
    label: group.label,
    memberIds: groupMembers([group])
      .map((entity) => entity.id)
      .filter((id) => activeIds.has(id)),
    namedAtRevision: args.revision,
  }));
  const freshGroupIds = new Set(freshGroups.map((group) => group.id));
  const carriedGroups = args.priorGroups
    .filter((group) => !freshGroupIds.has(group.id))
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((id) => activeIds.has(id)),
    }));
  return [...carriedGroups, ...freshGroups]
    .filter((group) => group.memberIds.length > 0)
    .slice(-4);
}

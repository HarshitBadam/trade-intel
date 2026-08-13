import { entityNameTokens, resolveEntityHints } from "../entity/entity-hints";
import { canonicalizeEntity, resolveGroup } from "../entity/entity-resolution";
import type {
  ConversationState,
  FinanceEntity,
} from "../types";
import type { ResolvedPair, SubjectDatePair } from "./contracts";

function tickerHint(subject: string): string | undefined {
  const value = subject.trim().toUpperCase().replace(/^\$/, "");
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(value) ? value : undefined;
}

export function resolvePairs(
  pairs: readonly SubjectDatePair[],
  known: readonly FinanceEntity[]
): ResolvedPair[] {
  const resolved: ResolvedPair[] = [];
  const seen = new Set<string>();
  for (const [subject, date] of pairs) {
    const group = resolveGroup(subject);
    const entities =
      group.length > 0
        ? group
        : resolveEntityHints(
            [{ name: subject, ticker: tickerHint(subject) }],
            [...known]
          );
    for (const candidate of entities) {
      const entity = canonicalizeEntity(candidate) ?? candidate;
      const key = `${entity.id}:${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ subject, date, entity });
      if (resolved.length >= 24) return resolved;
    }
  }
  return resolved;
}

function issuerIdentity(entity: FinanceEntity): string {
  const tokens = entityNameTokens(entity.name, 2);
  return tokens.slice(0, 2).join(" ") || entity.id;
}

export function dedupeResolvedIssuerPairs(
  pairs: readonly ResolvedPair[],
  preferredEntities: readonly FinanceEntity[]
): ResolvedPair[] {
  const preferredIds = new Set(preferredEntities.map((entity) => entity.id));
  const entitiesByIssuer = new Map<string, FinanceEntity[]>();
  for (const pair of pairs) {
    const key = issuerIdentity(pair.entity);
    const current = entitiesByIssuer.get(key) ?? [];
    if (!current.some((entity) => entity.id === pair.entity.id)) {
      current.push(pair.entity);
      entitiesByIssuer.set(key, current);
    }
  }
  const selectedIds = new Set<string>();
  for (const entities of entitiesByIssuer.values()) {
    const preferred = entities.filter((entity) => preferredIds.has(entity.id));
    const selected = preferred.length > 0 ? preferred : entities.slice(0, 1);
    for (const entity of selected) selectedIds.add(entity.id);
  }
  return pairs.filter((pair) => selectedIds.has(pair.entity.id));
}

export function mergeResolvedEntities(
  state: ConversationState,
  priorState: ConversationState | undefined,
  entities: readonly FinanceEntity[]
): ConversationState {
  if (entities.length === 0) return state;
  const current = [
    ...new Map(entities.map((entity) => [entity.id, entity])).values(),
  ];
  const priorExplicitIds = priorState?.explicitEntitySet ?? [];
  const currentIds = new Set(current.map((entity) => entity.id));
  const preservesPriorOrder =
    priorExplicitIds.length >= 2 &&
    current.length < priorExplicitIds.length &&
    current.every((entity) => priorExplicitIds.includes(entity.id));
  const allKnown = new Map(
    [
      ...(priorState?.entities ?? []),
      ...state.entities,
      ...current,
    ].map((entity) => [entity.id, entity])
  );
  const explicitEntitySet = preservesPriorOrder
    ? priorExplicitIds.filter((id) => allKnown.has(id)).slice(0, 12)
    : current.map((entity) => entity.id).slice(0, 12);
  const ordered = [
    ...explicitEntitySet.flatMap((id) => {
      const entity = allKnown.get(id);
      return entity ? [entity] : [];
    }),
    ...current.filter((entity) => !explicitEntitySet.includes(entity.id)),
  ].slice(0, 12);
  return {
    ...state,
    version: 1,
    entities: ordered,
    explicitEntitySet,
    focusEntityIds: [...currentIds],
  };
}

import { isInUniverse, searchUniverse } from "@/lib/market-data/universe";
import { resolveTickers } from "@/lib/tickers";
import {
  CANONICAL_GROUPS,
  LISTING_NAMES,
  WEB_ALIASES,
  type WebAlias,
} from "./entity-catalog";
import {
  detectCriteria,
  detectHorizon,
  detectJurisdiction,
} from "./conversation-attributes";
import { sanitizeConversationState } from "./state";
import type {
  ChatTurn,
  ConversationState,
  FinanceEntity,
} from "./types";
export { CANONICAL_GROUPS } from "./entity-catalog";

const PLURAL_REFERENCE = /\b(?:they|their|them|those|these)\b/i;
const SINGULAR_REFERENCE = /\b(?:it|its|that one|this one|the company|the stock|the shares|what about|how about)\b/i;
const ORDERED_REFERENCE = /\b(?:former|latter|first one|second one)\b/i;
const COMPARISON_FOLLOW_UP =
  /\b(?:which (?:one|is)|what about|how about|better|safer|less risky|more risky|yesterday|last (?:week|month|quarter|year)|this (?:week|month|quarter|year)|over (?:the )?last|past \d+|between)\b/i;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addEntity(
  output: FinanceEntity[],
  seen: Set<string>,
  entity: FinanceEntity
): void {
  const key = entity.id;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(entity);
}

function entityId(ticker: string | undefined, name: string): string {
  return ticker ? `ticker:${ticker.toUpperCase()}` : `name:${name.toLowerCase()}`;
}

function fromAlias(alias: WebAlias): FinanceEntity {
  return {
    id: entityId(alias.ticker, alias.name),
    name: alias.name,
    query: alias.query,
    ticker: alias.ticker,
    market: alias.market ?? "web",
    jurisdiction: alias.jurisdiction,
  };
}

function entityPosition(text: string, entity: FinanceEntity): number {
  const alias = WEB_ALIASES.find((candidate) => candidate.ticker === entity.ticker);
  const terms = [
    ...(alias?.aliases ?? []),
    entity.ticker,
    entity.name,
    entity.name.split(/[\s,]+/)[0],
  ].filter(
    (term): term is string => typeof term === "string" && term.length >= 3
  );
  const positions = terms
    .map((term) => text.search(new RegExp(`\\b${escaped(term)}\\b`, "i")))
    .filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
}

function canonicalizeEntity(entity: FinanceEntity): FinanceEntity | null {
  const alias = WEB_ALIASES.find(
    (candidate) =>
      (Boolean(entity.ticker) && candidate.ticker === entity.ticker) ||
      candidate.name === entity.name ||
      entity.id === entityId(candidate.ticker, candidate.name)
  );
  if (alias) return fromAlias(alias);
  const ticker = entity.ticker?.toUpperCase();
  if (!ticker || !/^[A-Z0-9.:-]{1,12}$/.test(ticker)) return null;
  if (isInUniverse(ticker)) {
    const name = searchUniverse(ticker, 1)[0]?.name ?? ticker;
    return {
      id: entityId(ticker, name),
      name,
      query: `${name} ${ticker}`,
      ticker,
      market: "us",
    };
  }
  return {
    id: entityId(ticker, ticker),
    name: ticker,
    query: `${ticker} company financial news`,
    ticker,
    market: "web",
  };
}

function resolveGroup(text: string): FinanceEntity[] {
  const group = CANONICAL_GROUPS.find((candidate) => candidate.aliases.test(text));
  if (!group) return [];
  return group.members
    .map((member) =>
      WEB_ALIASES.find(
        (alias) => alias.ticker === member || alias.name === member
      )
    )
    .filter((alias): alias is WebAlias => Boolean(alias))
    .map(fromAlias);
}

function resolveText(text: string): FinanceEntity[] {
  const clean = text.replace(/\bhey\s*,?\s*sage\b/gi, " ");
  const output: FinanceEntity[] = [];
  const seen = new Set<string>();
  const webTickers = new Set<string>();

  const matchedAliases = WEB_ALIASES.flatMap((alias) =>
    alias.aliases
      .map((candidate) => ({
        alias,
        index: clean.search(new RegExp(`\\b${escaped(candidate)}\\b`, "i")),
      }))
      .filter((match) => match.index >= 0)
  ).sort((a, b) => a.index - b.index);
  for (const { alias } of matchedAliases) {
    if (alias.ticker) webTickers.add(alias.ticker);
    addEntity(output, seen, fromAlias(alias));
  }

  const prefixed = /\b(ASX|LSE|TSX|HKEX|TSE|NSE|BSE)\s*:\s*([A-Z0-9]{1,6})\b/gi;
  for (const match of clean.matchAll(prefixed)) {
    const listing = match[1].toUpperCase();
    const ticker = match[2].toUpperCase();
    webTickers.add(ticker);
    addEntity(output, seen, {
      id: entityId(ticker, `${listing}:${ticker}`),
      name: `${listing}:${ticker}`,
      query: `${ticker} ${LISTING_NAMES[listing]} company`,
      ticker,
      market: "web",
      jurisdiction: LISTING_NAMES[listing],
    });
  }

  const suffixed = /\b([A-Z0-9]{1,6})\.(AX|L|TO|HK|T|NS|BO)\b/gi;
  for (const match of clean.matchAll(suffixed)) {
    const ticker = match[1].toUpperCase();
    const suffix = match[2].toUpperCase();
    webTickers.add(ticker);
    addEntity(output, seen, {
      id: entityId(ticker, `${ticker}.${suffix}`),
      name: `${ticker}.${suffix}`,
      query: `${ticker} ${LISTING_NAMES[suffix]} company`,
      ticker,
      market: "web",
      jurisdiction: LISTING_NAMES[suffix],
    });
  }

  for (const ticker of resolveTickers(clean, 8)) {
    if (webTickers.has(ticker) || !isInUniverse(ticker)) continue;
    const marker = "\\b(?:australian|australia|asx|non-us|foreign)\\b";
    const symbol = `\\b${escaped(ticker)}\\b`;
    const nearbyNonUs = new RegExp(
      `(?:${marker}.{0,40}${symbol}|${symbol}.{0,40}${marker})`,
      "i"
    ).test(clean);
    if (nearbyNonUs) {
      addEntity(output, seen, {
        id: entityId(ticker, ticker),
        name: ticker,
        query: `${ticker} company financial news`,
        ticker,
        market: "web",
      });
      continue;
    }
    const match = searchUniverse(ticker, 1)[0];
    const name = match?.name ?? ticker;
    addEntity(output, seen, {
      id: entityId(ticker, name),
      name,
      query: `${name} ${ticker}`,
      ticker,
      market: "us",
    });
  }

  return output
    .sort((left, right) => entityPosition(clean, left) - entityPosition(clean, right))
    .slice(0, 6);
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
  const removed = meantCorrection
    ? resolveText(meantCorrection[2])
    : replacementCorrection
      ? resolveText(replacementCorrection[1])
      : [];
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
    correctedExplicitSet = base.explicitEntitySet.flatMap((id) =>
      removedIds.has(id) ? replacementIds : [id]
    );
  }
  const grouped = resolveGroup(message);
  const byId = new Map(base.entities.map((entity) => [entity.id, entity]));
  const orderedMatch = message.match(/\b(former|latter|first one|second one)\b/i);
  if (orderedMatch) {
    if (base.explicitEntitySet.length !== 2) {
      return {
        state: base,
        entities: [],
        clarification:
          "Which two entities do you mean? Name them in order so I can resolve former and latter.",
        reasonCode: "ambiguous_ordered_reference",
      };
    }
    const first = /former|first/i.test(orderedMatch[1]);
    const id = base.explicitEntitySet[first ? 0 : 1];
    const entity = byId.get(id);
    if (!entity) {
      return {
        state: base,
        entities: [],
        clarification: "Please name the entity you mean.",
        reasonCode: "stale_ordered_reference",
      };
    }
    direct.unshift(entity);
  }

  const referencesPlural = PLURAL_REFERENCE.test(message);
  const referencesSingular = SINGULAR_REFERENCE.test(message);
  const comparisonFollowUp =
    !orderedMatch &&
    base.explicitEntitySet.length >= 2 &&
    COMPARISON_FOLLOW_UP.test(message);
  const referenced =
    removed.length > 0
      ? correctedBase
      : comparisonFollowUp || referencesPlural || (referencesSingular && direct.length === 0)
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
    : [...referenced, ...direct, ...grouped];
  const entities = [
    ...new Map(merged.map((entity) => [entity.id, entity])).values(),
  ].slice(0, 8);
  const explicit = [...direct, ...grouped];
  const retainComparisonContext =
    Boolean(orderedMatch) ||
    (direct.length === 0 &&
      grouped.length === 0 &&
      removed.length === 0 &&
      !fortuneReplacement);
  const criteria = detectCriteria(message);
  const next: ConversationState = {
    version: 1,
    revision: base.revision + 1,
    entities: retainComparisonContext
      ? base.entities
      : entities.length > 0
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
        : explicit.length > 0
        ? [...new Set(explicit.map((entity) => entity.id))]
        : base.explicitEntitySet,
    criteria: criteria.length > 0 ? criteria : base.criteria,
    horizon: detectHorizon(message) ?? base.horizon,
    jurisdiction:
      detectJurisdiction(message, entities) ?? base.jurisdiction,
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
          : referencesPlural || referencesSingular
            ? "conversation_reference_resolved"
            : direct.length > 0
              ? "explicit_entities"
              : "no_entities",
  };
}

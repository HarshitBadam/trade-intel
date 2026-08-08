import "server-only";

import { hasFinnhub } from "@/lib/config";
import {
  getTickerDetailCached,
  searchTickersCached,
} from "@/lib/market-data/cache-meta";
import { isInUniverse, searchUniverse } from "@/lib/market-data/universe";
import type { FinanceEntity, Turn } from "./types";

type ListedCandidate = { ticker: string; name: string };
export type ListingLookup = (name: string) => Promise<ListedCandidate[]>;

const KNOWN_LISTED_ALIASES: Record<string, string> = {
  spacex: "SPCX",
  "space x": "SPCX",
};

const IGNORED_NAME_TOKENS = new Set([
  "class",
  "common",
  "company",
  "corporation",
  "corp",
  "group",
  "holdings",
  "inc",
  "limited",
  "ltd",
  "ordinary",
  "shares",
  "stock",
  "technologies",
]);

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameTokens(value: string): string[] {
  return normalized(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !IGNORED_NAME_TOKENS.has(token));
}

function candidateMatches(entity: FinanceEntity, candidate: ListedCandidate): boolean {
  const subject = new Set(nameTokens(entity.name));
  const candidateName = new Set(nameTokens(candidate.name));
  if (subject.size === 0 || candidateName.size === 0) return false;
  return [...subject].some((token) => candidateName.has(token));
}

function listedEntity(
  entity: FinanceEntity,
  ticker: string,
  name?: string
): FinanceEntity {
  const symbol = ticker.toUpperCase();
  const displayName =
    entity.name ||
    name ||
    searchUniverse(symbol, 1)[0]?.name ||
    symbol;
  return {
    id: `ticker:${symbol}`,
    name: displayName,
    query: `${displayName} ${symbol} stock financial news`,
    ticker: symbol,
    market: "us",
    jurisdiction: "United States",
  };
}

async function defaultLookup(name: string): Promise<ListedCandidate[]> {
  if (!hasFinnhub) return [];
  const candidates = await searchTickersCached(name);
  const verified: ListedCandidate[] = [];
  for (const candidate of candidates.slice(0, 5)) {
    if (isInUniverse(candidate.ticker)) {
      verified.push(candidate);
      continue;
    }
    const profile = await getTickerDetailCached(candidate.ticker);
    if (profile) {
      verified.push({
        ticker: candidate.ticker,
        name: profile.name || candidate.name,
      });
    }
  }
  return verified;
}

/**
 * Upgrades stale web/private entities to a current US listing before evidence
 * planning. The static alias is only a hint; the existing universe and
 * Finnhub reference path decide whether a public instrument now exists.
 */
export async function enrichListingEntities(
  entities: readonly FinanceEntity[],
  lookup: ListingLookup = defaultLookup
): Promise<FinanceEntity[]> {
  const output: FinanceEntity[] = [];
  for (const entity of entities) {
    if (entity.ticker || (entity.market !== "web" && !entity.private)) {
      output.push(entity);
      continue;
    }
    const knownTicker = KNOWN_LISTED_ALIASES[normalized(entity.name)];
    if (knownTicker) {
      output.push(listedEntity(entity, knownTicker));
      continue;
    }
    try {
      const candidates = await lookup(entity.name);
      const match = candidates.find((candidate) =>
        candidateMatches(entity, candidate)
      );
      output.push(
        match ? listedEntity(entity, match.ticker, match.name) : entity
      );
    } catch {
      output.push(entity);
    }
  }
  return output;
}

function remapId(
  id: string,
  replacements: ReadonlyMap<string, FinanceEntity>
): string {
  return replacements.get(id)?.id ?? id;
}

/**
 * Returns one immutable-ready turn whose state, active entities, focus and
 * groups all share the same enriched listing identities.
 */
export async function enrichTurnListings(
  turn: Turn,
  lookup?: ListingLookup
): Promise<Turn> {
  const originals = [
    ...new Map(
      [...turn.context.state.entities, ...turn.context.entities].map(
        (entity): [string, FinanceEntity] => [entity.id, entity]
      )
    ).values(),
  ];
  const enriched = await enrichListingEntities(originals, lookup);
  const replacements = new Map(
    originals.map((entity, index): [string, FinanceEntity] => [
      entity.id,
      enriched[index],
    ])
  );
  if (
    originals.every((entity) => replacements.get(entity.id)?.id === entity.id)
  ) {
    return turn;
  }
  const mapEntity = (entity: FinanceEntity) =>
    replacements.get(entity.id) ?? entity;
  const state = {
    ...turn.context.state,
    entities: turn.context.state.entities.map(mapEntity),
    explicitEntitySet: turn.context.state.explicitEntitySet.map((id) =>
      remapId(id, replacements)
    ),
    ...(turn.context.state.focusEntityIds
      ? {
          focusEntityIds: turn.context.state.focusEntityIds.map((id) =>
            remapId(id, replacements)
          ),
        }
      : {}),
    ...(turn.context.state.groups
      ? {
          groups: turn.context.state.groups.map((group) => ({
            ...group,
            memberIds: group.memberIds.map((id) =>
              remapId(id, replacements)
            ),
          })),
        }
      : {}),
  };
  const context = {
    ...turn.context,
    state,
    entities: turn.context.entities.map(mapEntity),
    focusEntities: turn.context.focusEntities.map(mapEntity),
    groups: state.groups ?? [],
  };
  return { decision: turn.decision, context };
}

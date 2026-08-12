import { isInUniverse, searchUniverse } from "@/lib/market-data/universe";
import { resolveTickers } from "@/lib/tickers";
import {
  CANONICAL_GROUPS,
  LISTING_NAMES,
  WEB_ALIASES,
  type CanonicalGroup,
  type WebAlias,
} from "./entity-catalog";
import {
  isWithinOneEdit,
  isWithinTwoEdits,
} from "./text-normalization";
import type { FinanceEntity } from "./types";

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function addEntity(
  output: FinanceEntity[],
  seen: Set<string>,
  entity: FinanceEntity
): void {
  const key = entity.id;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(entity);
}

export function entityId(ticker: string | undefined, name: string): string {
  return ticker ? `ticker:${ticker.toUpperCase()}` : `name:${name.toLowerCase()}`;
}

export function fromAlias(alias: WebAlias): FinanceEntity {
  return {
    id: entityId(alias.ticker, alias.name),
    name: alias.name,
    query: alias.query,
    ticker: alias.ticker,
    market:
      alias.market ??
      (alias.ticker && isInUniverse(alias.ticker) ? "us" : "web"),
    jurisdiction: alias.jurisdiction,
    ...(alias.private ? { private: true } : {}),
  };
}

function entityPosition(text: string, entity: FinanceEntity): number {
  const alias = WEB_ALIASES.find((candidate) => candidate.ticker === entity.ticker);
  const terms = [
    ...(alias?.aliases ?? []),
    entity.ticker,
    entity.name,
    entity.name.split(/[\s,.]+/)[0],
  ].filter(
    (term): term is string => typeof term === "string" && term.length >= 3
  );
  const positions = terms
    .map((term) => text.search(new RegExp(`\\b${escaped(term)}\\b`, "i")))
    .filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
}

export function canonicalizeEntity(entity: FinanceEntity): FinanceEntity | null {
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

// Shared by both directions of the professional-services qualifier check: a
// qualifier immediately before ("consulting Big 4") or after ("Big 4
// consulting firms") the bare "big four" phrase means the professional-
// services group matched, not the Australian banks.
const PROFESSIONAL_SERVICES_QUALIFIER =
  /consulting|consultanc(?:y|ies)|consultants?|accounting|accountants?|audit(?:ors?)?|professional services/i;

/**
 * The groups a message named, in the order they appear. Callers that only need
 * members use `resolveGroup`; state tracking needs the group identities too.
 */
export function resolveGroupRefs(text: string): CanonicalGroup[] {
  return CANONICAL_GROUPS.map((candidate) => {
    const found = text.match(candidate.aliases);
    return { candidate, found };
  })
    .filter(
      (
        match
      ): match is { candidate: CanonicalGroup; found: RegExpMatchArray } =>
        match.found !== null
    )
    .filter((match) => {
      const index = match.found.index ?? 0;
      const end = index + match.found[0].length;
      const prefix = text.slice(Math.max(0, index - 32), index);
      if (/\bnot(?:\s+the)?\s*$/i.test(prefix)) return false;
      if (match.candidate.id !== "australian-big-four") return true;
      // The bare Australian-bank phrase is always a substring of the longer
      // professional-services alias, so a qualifier immediately before or
      // after this match means the professional-services group is the real
      // referent, even though this candidate's own (shorter) pattern still
      // matched.
      const suffix = text.slice(end, end + 32);
      return !(
        new RegExp(`\\b(?:${PROFESSIONAL_SERVICES_QUALIFIER.source})\\s*$`, "i").test(
          prefix
        ) ||
        new RegExp(`^\\s*(?:${PROFESSIONAL_SERVICES_QUALIFIER.source})\\b`, "i").test(
          suffix
        )
      );
    })
    .sort((left, right) => (left.found.index ?? 0) - (right.found.index ?? 0))
    .map((match) => match.candidate);
}

export function groupMembers(groups: CanonicalGroup[]): FinanceEntity[] {
  return [
    ...new Map(
      groups
        .flatMap((group) => group.members)
        .map((member) =>
          WEB_ALIASES.find(
            (alias) => alias.ticker === member || alias.name === member
          )
        )
        .filter((alias): alias is WebAlias => Boolean(alias))
        .map(fromAlias)
        .map((entity): [string, FinanceEntity] => [entity.id, entity])
    ).values(),
  ];
}

export function resolveGroup(text: string): FinanceEntity[] {
  return groupMembers(resolveGroupRefs(text));
}

const EXCHANGE_CONTEXT_TICKERS = new Set(["ASX", "LSE", "TSX", "HKEX", "TSE", "NSE", "BSE", "NYSE", "AX"]);

// Treat bare "the ASX" as the market index only in market-performance asks.
const ASX_INDEX_CONTEXT =
  /\bhow(?:'?s| is| has| did| was| are)?\s+(?:the\s+)?asx\b|\b(?:the\s+)?asx\b[^.!?\n]{0,24}\b(?:done|doing|perform\w*|today|up|down|fell|rose|dropped|climbed|this (?:week|month|year)|ytd|year[- ]to[- ]date)\b/i;

export function resolveText(text: string): FinanceEntity[] {
  const clean = text.replace(/\bhey\s*,?\s*sage\b/gi, " ");
  const output: FinanceEntity[] = [];
  const seen = new Set<string>();
  const webTickers = new Set<string>();

  if (ASX_INDEX_CONTEXT.test(clean) && !/\basx\s*:/i.test(clean)) {
    const index = WEB_ALIASES.find((alias) => alias.ticker === "AXJO");
    if (index) addEntity(output, seen, fromAlias(index));
  }

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

  // Only recover distinctive aliases; reject short or ambiguous near-matches.
  const words = [...clean.toLowerCase().matchAll(/\b[a-z][a-z0-9]{5,}\b/g)];
  const fuzzyMatches: { alias: WebAlias; index: number }[] = [];
  for (const word of words) {
    const token = word[0];
    const candidates = [
      ...new Map(
        WEB_ALIASES.flatMap((alias) =>
          alias.aliases
            .filter(
              (candidate) =>
                /^[a-z0-9]{6,}$/i.test(candidate) &&
                candidate.toLowerCase() !== token &&
                (isWithinOneEdit(token, candidate.toLowerCase()) ||
                  (token.length >= 8 &&
                    candidate.length >= 8 &&
                    isWithinTwoEdits(token, candidate.toLowerCase())))
            )
            .map((): [string, WebAlias] => [
              entityId(alias.ticker, alias.name),
              alias,
            ])
        )
      ).values(),
    ];
    if (candidates.length === 1) {
      fuzzyMatches.push({ alias: candidates[0], index: word.index ?? 0 });
    }
  }
  for (const { alias } of fuzzyMatches.sort((a, b) => a.index - b.index)) {
    if (alias.ticker) webTickers.add(alias.ticker);
    addEntity(output, seen, fromAlias(alias));
  }

  const prefixed = /\b(ASX|LSE|TSX|HKEX|TSE|NSE|BSE)\s*:\s*([A-Z0-9]{1,6})\b/gi;
  for (const match of clean.matchAll(prefixed)) {
    const listing = match[1].toUpperCase();
    const ticker = match[2].toUpperCase();
    webTickers.add(ticker);
    const alias = WEB_ALIASES.find((candidate) => candidate.ticker === ticker);
    addEntity(
      output,
      seen,
      alias
        ? fromAlias(alias)
        : {
            id: entityId(ticker, `${listing}:${ticker}`),
            name: `${listing}:${ticker}`,
            query: `${ticker} ${LISTING_NAMES[listing]} company`,
            ticker,
            market: "web",
            jurisdiction: LISTING_NAMES[listing],
          }
    );
  }

  const suffixed = /\b([A-Z0-9]{1,6})\.(AX|L|TO|HK|T|NS|BO)\b/gi;
  for (const match of clean.matchAll(suffixed)) {
    const ticker = match[1].toUpperCase();
    const suffix = match[2].toUpperCase();
    webTickers.add(ticker);
    const alias = WEB_ALIASES.find((candidate) => candidate.ticker === ticker);
    addEntity(
      output,
      seen,
      alias
        ? fromAlias(alias)
        : {
            id: entityId(ticker, `${ticker}.${suffix}`),
            name: `${ticker}.${suffix}`,
            query: `${ticker} ${LISTING_NAMES[suffix]} company`,
            ticker,
            market: "web",
            jurisdiction: LISTING_NAMES[suffix],
          }
    );
  }

  const withoutListingSyntax = clean
    .replace(prefixed, " ")
    .replace(suffixed, " ");
  for (const ticker of resolveTickers(withoutListingSyntax, 8)) {
    if (EXCHANGE_CONTEXT_TICKERS.has(ticker)) continue;
    if (webTickers.has(ticker)) continue;
    const knownWebAlias = WEB_ALIASES.find(
      (candidate) => candidate.ticker === ticker
    );
    if (knownWebAlias) {
      webTickers.add(ticker);
      addEntity(output, seen, fromAlias(knownWebAlias));
      continue;
    }
    if (!isInUniverse(ticker)) continue;
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
    .slice(0, 8);
}

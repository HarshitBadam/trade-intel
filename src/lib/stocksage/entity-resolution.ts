import { isInUniverse, searchUniverse } from "@/lib/market-data/universe";
import { resolveTickers } from "@/lib/tickers";
import {
  CANONICAL_GROUPS,
  LISTING_NAMES,
  WEB_ALIASES,
  type WebAlias,
} from "./entity-catalog";
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

export function resolveGroup(text: string): FinanceEntity[] {
  const groups = CANONICAL_GROUPS.map((candidate) => ({
    candidate,
    index: text.search(candidate.aliases),
  }))
    .filter((match) => match.index >= 0)
    .filter((match) => {
      const prefix = text.slice(Math.max(0, match.index - 32), match.index);
      if (/\bnot(?:\s+the)?\s*$/i.test(prefix)) return false;
      return !(
        match.candidate.id === "australian-big-four" &&
        /\b(?:consulting|consultancy|accounting|audit|professional services)\s*$/i.test(
          prefix
        )
      );
    })
    .sort((left, right) => left.index - right.index)
    .map((match) => match.candidate);
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

const EXCHANGE_CONTEXT_TICKERS = new Set(["ASX", "LSE", "TSX", "HKEX", "TSE", "NSE", "BSE", "NYSE", "AX"]);

export function resolveText(text: string): FinanceEntity[] {
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

  const withoutListingSyntax = clean
    .replace(prefixed, " ")
    .replace(suffixed, " ");
  for (const ticker of resolveTickers(withoutListingSyntax, 8)) {
    if (EXCHANGE_CONTEXT_TICKERS.has(ticker)) continue;
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
    .slice(0, 8);
}

import { isInUniverse, searchUniverse } from "@/lib/market-data/security-master/universe";
import { WEB_ALIASES } from "./entity-catalog";
import {
  addEntity,
  entityId,
  fromAlias,
  resolveText,
} from "./entity-resolution";
import type { FinanceEntity } from "../types";

const GENERIC_NAME_TOKENS = new Set([
  "class",
  "common",
  "company",
  "capital",
  "corp",
  "corporation",
  "global",
  "group",
  "holdings",
  "inc",
  "limited",
  "ordinary",
  "stock",
]);

export function entityNameTokens(
  value: string,
  minLength = 4
): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(
      (token) =>
        token.length >= minLength && !GENERIC_NAME_TOKENS.has(token)
    );
}

function namesOverlap(left: string, right: string): boolean {
  const leftTokens = entityNameTokens(left);
  const rightTokens = new Set(entityNameTokens(right));
  return leftTokens.some((token) => rightTokens.has(token));
}

export type EntityHint = { name: string; ticker?: string };

export function resolveEntityHints(
  hints: EntityHint[],
  known: FinanceEntity[] = []
): FinanceEntity[] {
  const output: FinanceEntity[] = [];
  const seen = new Set<string>();
  for (const hint of hints.slice(0, 8)) {
    const name = hint.name.trim();
    if (!name) continue;
    const lower = name.toLowerCase();

    const alias = WEB_ALIASES.find(
      (candidate) =>
        candidate.name.toLowerCase() === lower ||
        candidate.aliases.some((value) => value.toLowerCase() === lower)
    );
    if (alias) {
      addEntity(output, seen, fromAlias(alias));
      continue;
    }

    const prior = known.find(
      (entity) =>
        entity.name.toLowerCase() === lower ||
        (hint.ticker && entity.ticker === hint.ticker)
    );
    if (prior) {
      addEntity(output, seen, prior);
      continue;
    }

    const ticker = hint.ticker?.toUpperCase();
    if (ticker && isInUniverse(ticker)) {
      const universeName = searchUniverse(ticker, 1)[0]?.name;
      if (
        universeName &&
        (namesOverlap(universeName, name) || ticker === name.toUpperCase())
      ) {
        addEntity(output, seen, {
          id: entityId(ticker, universeName),
          name: universeName,
          query: `${universeName} ${ticker}`,
          ticker,
          market: "us",
        });
        continue;
      }
    }

    const resolved = resolveText(name);
    if (resolved.length > 0) {
      addEntity(output, seen, resolved[0]);
      continue;
    }

    if (name.length >= 4) {
      const byName = searchUniverse(name, 1)[0];
      if (byName && byName.name.toUpperCase().startsWith(name.toUpperCase())) {
        addEntity(output, seen, {
          id: entityId(byName.symbol, byName.name),
          name: byName.name,
          query: `${byName.name} ${byName.symbol}`,
          ticker: byName.symbol,
          market: "us",
        });
        continue;
      }
    }

    addEntity(output, seen, {
      id: entityId(undefined, name),
      name,
      query: `${name} financial news`,
      market: "web",
    });
  }
  return output.slice(0, 8);
}

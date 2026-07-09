import "server-only";

import universe from "@/data/universe.json";

export type UniverseEntry = { symbol: string; name: string };

// The committed universe is ordered seed-block-first, then alphabetically —
// so plain file order doubles as a recognizability prior when scores tie.
const ENTRIES: readonly UniverseEntry[] = universe.tickers;

const INDEX = ENTRIES.map((entry) => ({
  entry,
  symbol: entry.symbol.toUpperCase(),
  name: entry.name.toUpperCase(),
}));

const SYMBOLS = new Set(INDEX.map((x) => x.symbol));

// Score buckets, best first: exact symbol > symbol prefix > symbol substring
// > name prefix > name substring. Within a bucket, file order (seed block first)
// breaks ties. A linear scan of ~12k entries is sub-millisecond.
export function searchUniverse(query: string, limit = 8): UniverseEntry[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const buckets: UniverseEntry[][] = [[], [], [], [], []];
  for (const { entry, symbol, name } of INDEX) {
    if (symbol === q) buckets[0].push(entry);
    else if (symbol.startsWith(q)) buckets[1].push(entry);
    else if (symbol.includes(q)) buckets[2].push(entry);
    else if (name.startsWith(q)) buckets[3].push(entry);
    else if (name.includes(q)) buckets[4].push(entry);
  }
  const out: UniverseEntry[] = [];
  for (const bucket of buckets) {
    for (const entry of bucket) {
      out.push(entry);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function isInUniverse(symbol: string): boolean {
  return SYMBOLS.has(symbol.trim().toUpperCase());
}

export function getUniverse(): readonly UniverseEntry[] {
  return ENTRIES;
}

import "server-only";

import { unstable_cache } from "next/cache";
import {
  FALLBACK_TICKERS,
  CRON_WARMUP_TICKERS,
  CURATED_PEERS,
} from "@/data/fallbacks";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import { mapAlpacaSnapshotQuote } from "../transforms";
import { polygonFetch, assertPolygonOk } from "../providers/polygon";
import { getAlpacaSnapshots, getAlpacaMultiBars } from "../providers/alpaca";
import type { LiveQuote, Mover } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (ms: number) => new Date(ms).toISOString();

const MOVER_NAMES = new Map(FALLBACK_TICKERS.map((t) => [t.ticker, t.name]));
const MOVER_SYMBOLS = FALLBACK_TICKERS.map((t) => t.ticker);
const MOVER_SYMBOL_SET = new Set(MOVER_SYMBOLS);
type GroupedRow = { T: string; o: number; c: number; v: number };

// The bounded symbol universe the Alpaca snapshot market-map covers. Deliberately
// NOT the full search universe (~12.5k names), that would balloon one snapshot
// into ~126 chunked calls. Polygon's grouped-daily fallback still covers the entire
// market when Alpaca isn't configured.
const KNOWN_UNIVERSE: string[] = (() => {
  const set = new Set<string>();
  for (const t of FALLBACK_TICKERS) set.add(t.ticker);
  for (const t of CRON_WARMUP_TICKERS) set.add(t.ticker);
  for (const [key, peers] of Object.entries(CURATED_PEERS)) {
    set.add(key);
    for (const p of peers) set.add(p);
  }
  return [...set];
})();

// Snapshots are IEX-only on Alpaca's free plan (~2.5% of US volume), so snapshot
// volume is undercounted. SIP daily bars carry full-market volume and are free for
// windows ending >=15 min ago, so we source the session's true volume here and
// overlay it onto snapshot quotes.
async function fetchSessionVolumes(symbolsKey: string): Promise<Record<string, number>> {
  const symbols = symbolsKey.split(",").filter(Boolean);
  if (symbols.length === 0 || !hasAlpaca) return {};
  try {
    const start = isoTime(Date.now() - 6 * DAY_MS);
    const end = isoTime(Date.now());
    const bySym = await getAlpacaMultiBars(symbols, "1Day", start, end);
    const map: Record<string, number> = {};
    for (const [sym, bars] of Object.entries(bySym)) {
      const last = bars[bars.length - 1];
      if (last && typeof last.v === "number" && last.v > 0) map[sym] = last.v;
    }
    return map;
  } catch (error) {
    console.error("[alpaca] session volumes failed:", error);
    return {};
  }
}

export const getSessionVolumesForCached = unstable_cache(
  fetchSessionVolumes,
  ["session-volumes"],
  { revalidate: 300, tags: ["movers"] }
);

export function applySessionVolumes(
  quotes: Record<string, LiveQuote>,
  vols: Record<string, number>
): Record<string, LiveQuote> {
  for (const s of Object.keys(quotes)) {
    const v = vols[s];
    if (typeof v === "number" && v > 0) quotes[s].volume = v;
  }
  return quotes;
}

export function volumeKey(symbols: string[]): string {
  return [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(",");
}

async function fetchGroupedDaily(): Promise<Mover[] | null> {
  if (hasAlpaca) {
    try {
      const snaps = await getAlpacaSnapshots(MOVER_SYMBOLS);
      const movers: Mover[] = [];
      for (const { ticker, name } of FALLBACK_TICKERS) {
        const q = mapAlpacaSnapshotQuote(ticker, snaps[ticker]);
        if (q) movers.push({ ...q, name });
      }
      if (movers.length > 0) {
        const vols = await getSessionVolumesForCached(
          movers.map((m) => m.ticker).sort().join(",")
        );
        for (const m of movers) {
          const v = vols[m.ticker];
          if (typeof v === "number" && v > 0) m.volume = v;
        }
        return movers;
      }
    } catch (error) {
      console.error("[alpaca] movers snapshot failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    for (let back = 1; back <= 6; back++) {
      const day = new Date(Date.now() - back * DAY_MS);
      const response = await polygonFetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmtDay(day)}?adjusted=true`
      );
      assertPolygonOk(response, "grouped daily");
      const data = await response.json();
      const rows = (data.results ?? []) as GroupedRow[];
      if (rows.length === 0) continue;

      const movers = rows
        .filter((r) => MOVER_SYMBOL_SET.has(r.T) && r.o > 0)
        .map((r) => ({
          ticker: r.T,
          name: MOVER_NAMES.get(r.T) ?? r.T,
          price: r.c,
          change: r.c - r.o,
          percentChange: ((r.c - r.o) / r.o) * 100,
          volume: r.v,
        }));
      if (movers.length > 0) return movers;
    }
  }
  return null;
}

export const getGroupedDailyCached = unstable_cache(
  fetchGroupedDaily,
  ["market-movers"],
  { revalidate: 3600, tags: ["movers"] }
);

async function fetchMarketMap(): Promise<Record<string, LiveQuote>> {
  if (hasAlpaca) {
    try {
      const [snaps, vols] = await Promise.all([
        getAlpacaSnapshots(KNOWN_UNIVERSE),
        getSessionVolumesForCached(volumeKey(KNOWN_UNIVERSE)),
      ]);
      const map: Record<string, LiveQuote> = {};
      for (const sym of Object.keys(snaps)) {
        const q = mapAlpacaSnapshotQuote(sym, snaps[sym]);
        if (q) map[sym] = q;
      }
      if (Object.keys(map).length > 0) return applySessionVolumes(map, vols);
    } catch (error) {
      console.error("[alpaca] market map snapshot failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    for (let back = 1; back <= 6; back++) {
      const day = new Date(Date.now() - back * DAY_MS);
      const response = await polygonFetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmtDay(day)}?adjusted=true`
      );
      assertPolygonOk(response, "market map");
      const data = await response.json();
      const rows = (data.results ?? []) as GroupedRow[];
      if (rows.length === 0) continue;

      const map: Record<string, LiveQuote> = {};
      for (const r of rows) {
        if (r.o > 0) {
          map[r.T] = {
            ticker: r.T,
            price: r.c,
            change: r.c - r.o,
            percentChange: ((r.c - r.o) / r.o) * 100,
            volume: r.v,
          };
        }
      }
      return map;
    }
  }
  return {};
}

export const getMarketMapCached = unstable_cache(
  fetchMarketMap,
  ["market-map"],
  { revalidate: 3600, tags: ["movers"] }
);

async function fetchMarketMapYearAgo(): Promise<Record<string, number>> {
  if (hasAlpaca) {
    try {
      const start = isoTime(Date.now() - 372 * DAY_MS);
      const end = isoTime(Date.now() - 358 * DAY_MS);
      const bySym = await getAlpacaMultiBars(KNOWN_UNIVERSE, "1Day", start, end);
      const map: Record<string, number> = {};
      for (const [sym, bars] of Object.entries(bySym)) {
        const first = bars[0];
        if (first && typeof first.c === "number" && first.c > 0) {
          map[sym] = first.c;
        }
      }
      if (Object.keys(map).length > 0) return map;
    } catch (error) {
      console.error("[alpaca] year-ago bars failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    for (let back = 365; back >= 359; back--) {
      const day = new Date(Date.now() - back * DAY_MS);
      const response = await polygonFetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmtDay(day)}?adjusted=true`
      );
      assertPolygonOk(response, "market map (year ago)");
      const data = await response.json();
      const rows = (data.results ?? []) as GroupedRow[];
      if (rows.length === 0) continue;

      const map: Record<string, number> = {};
      for (const r of rows) if (r.c > 0) map[r.T] = r.c;
      return map;
    }
  }
  return {};
}

export const getMarketMapYearAgoCached = unstable_cache(
  fetchMarketMapYearAgo,
  ["market-map-year-ago"],
  { revalidate: 86_400, tags: ["movers"] }
);

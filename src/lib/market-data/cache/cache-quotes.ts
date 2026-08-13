import "server-only";

import { unstable_cache } from "next/cache";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import { mapAlpacaSnapshotQuote } from "../transforms";
import { getAlpacaSnapshots, getAlpacaMultiBars } from "../providers/alpaca";
import {
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getSessionVolumesForCached,
  applySessionVolumes,
  volumeKey,
} from "./cache-market";
import type { LiveQuote } from "../types";

// Quotes for an ARBITRARY, exact symbol set (e.g. a peer group Finnhub just
// returned), independent of KNOWN_UNIVERSE. The curated-universe snapshot is
// right for movers (a fixed known set), but a related-stock peer can be any US
// ticker; intersecting with a static list would silently drop real peers.
// Alpaca has no "whole market" snapshot, so we snapshot exactly the symbols asked.
// Polygon's fallback IS whole-market, so it reuses the shared map.
async function fetchQuotesFor(symbolsKey: string): Promise<Record<string, LiveQuote>> {
  const symbols = symbolsKey.split(",").filter(Boolean);
  if (symbols.length === 0) return {};
  if (hasAlpaca) {
    try {
      const [snaps, vols] = await Promise.all([
        getAlpacaSnapshots(symbols),
        getSessionVolumesForCached(volumeKey(symbols)),
      ]);
      const map: Record<string, LiveQuote> = {};
      for (const sym of symbols) {
        const q = mapAlpacaSnapshotQuote(sym, snaps[sym]);
        if (q) map[sym] = q;
      }
      if (Object.keys(map).length > 0) return applySessionVolumes(map, vols);
    } catch (error) {
      console.error("[alpaca] targeted quotes failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    const whole = await getMarketMapCached().catch(() => ({}) as Record<string, LiveQuote>);
    const map: Record<string, LiveQuote> = {};
    for (const sym of symbols) if (whole[sym]) map[sym] = whole[sym];
    return map;
  }
  return {};
}

export const getQuotesForCached = unstable_cache(
  fetchQuotesFor,
  ["targeted-quotes"],
  { revalidate: 300, tags: ["movers"] }
);

// Year-ago close for an ARBITRARY, exact symbol set, same rationale as
// getQuotesForCached (a peer group is never bounded to KNOWN_UNIVERSE).
async function fetchYearAgoQuotesFor(symbolsKey: string): Promise<Record<string, number>> {
  const symbols = symbolsKey.split(",").filter(Boolean);
  if (symbols.length === 0) return {};
  if (hasAlpaca) {
    try {
      const start = new Date(Date.now() - 372 * 24 * 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() - 358 * 24 * 60 * 60 * 1000).toISOString();
      const bySym = await getAlpacaMultiBars(symbols, "1Day", start, end);
      const map: Record<string, number> = {};
      for (const [sym, bars] of Object.entries(bySym)) {
        const first = bars[0];
        if (first && typeof first.c === "number" && first.c > 0) {
          map[sym] = first.c;
        }
      }
      if (Object.keys(map).length > 0) return map;
    } catch (error) {
      console.error("[alpaca] targeted year-ago quotes failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    const whole = await getMarketMapYearAgoCached().catch(() => ({}) as Record<string, number>);
    const map: Record<string, number> = {};
    for (const sym of symbols) if (whole[sym]) map[sym] = whole[sym];
    return map;
  }
  return {};
}

export const getYearAgoQuotesForCached = unstable_cache(
  fetchYearAgoQuotesFor,
  ["targeted-year-ago-quotes"],
  { revalidate: 86_400, tags: ["movers"] }
);

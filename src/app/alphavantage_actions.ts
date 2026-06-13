"use server";

import { unstable_cache } from "next/cache";
import { generateMockCandles } from "@/data/fallbacks";
import { hasPolygon, POLYGON_API_KEY } from "@/lib/config";
import { guard } from "@/lib/guard";

type Candle = { date: number; mobile: number; desktop: number };

function mockCandles(symbol: string): Candle[] {
  return generateMockCandles(symbol).map((candle) => ({
    date: new Date(candle.date).getTime(),
    mobile: candle.value,
    desktop: candle.value,
  }));
}

const fetchCandlesCached = unstable_cache(
  async (symbol: string): Promise<Candle[] | null> => {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // Pass the key via Authorization header rather than the query string, so it
    // can't leak through request logs, proxies or error traces.
    const response = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=50000`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      }
    );

    const data = await response.json();
    if (!data.results) return null;
    return data.results.map((candle: { t: number; c: number; o: number }) => ({
      date: candle.t,
      mobile: candle.c,
      desktop: candle.o,
    }));
  },
  ["polygon-candles-simple"],
  { revalidate: 300, tags: ["candles"] }
);

export async function getStockCandles(symbol: string): Promise<Candle[]> {
  const cleaned = (symbol ?? "").toString().toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 6);
  if (!cleaned) return mockCandles("N/A");

  const access = await guard("candles", { limit: 30, windowSec: 60 });
  if (!access.ok) {
    return mockCandles(cleaned);
  }

  if (hasPolygon) {
    try {
      const cached = await fetchCandlesCached(cleaned);
      if (cached) return cached;
    } catch (error) {
      // Log only the message to avoid echoing any request details.
      console.error(
        "Polygon fetch failed, using fallback:",
        error instanceof Error ? error.message : "unknown error"
      );
    }
  }

  return mockCandles(cleaned);
}

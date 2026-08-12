import "server-only";

import {
  ALPACA_API_KEY_ID,
  ALPACA_API_SECRET_KEY,
  ALPACA_FEED,
  ALPACA_HISTORICAL_FEED,
} from "@/lib/config";
import { slidingLimiter } from "./limiter";

const DATA_BASE = "https://data.alpaca.markets";
const REQUEST_TIMEOUT_MS = 8_000;

const acquire = slidingLimiter(180, 60_000);

const SIP_MIN_DELAY_MS = 16 * 60 * 1000;

function barsFeedChain(): string[] {
  return ALPACA_HISTORICAL_FEED === "sip" ? ["sip", "iex"] : [ALPACA_HISTORICAL_FEED];
}

function clampEnd(endISO: string, feed: string): string {
  if (feed !== "sip") return endISO;
  const end = Date.parse(endISO);
  const maxEnd = Date.now() - SIP_MIN_DELAY_MS;
  return Number.isFinite(end) && end > maxEnd ? new Date(maxEnd).toISOString() : endISO;
}

function authHeaders(): HeadersInit {
  return {
    "APCA-API-KEY-ID": ALPACA_API_KEY_ID ?? "",
    "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY ?? "",
  };
}

async function alpacaFetch(path: string): Promise<Response> {
  await acquire();
  return fetch(`${DATA_BASE}${path}`, {
    cache: "no-store",
    headers: authHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export type AlpacaBar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
};

export type AlpacaTimeframe = "1Day" | "15Min" | "1Min";

function barsQuery(
  timeframe: AlpacaTimeframe,
  startISO: string,
  endISO: string,
  limit: number,
  feed: string,
  pageToken?: string
): string {
  const params = new URLSearchParams({
    timeframe,
    start: startISO,
    end: clampEnd(endISO, feed),
    limit: String(limit),
    adjustment: "all",
    feed,
    sort: "asc",
  });
  if (pageToken) params.set("page_token", pageToken);
  return params.toString();
}

async function fetchBarsForFeed(
  symbol: string,
  timeframe: AlpacaTimeframe,
  startISO: string,
  endISO: string,
  feed: string,
  limitPerPage = 10_000
): Promise<{ bars: AlpacaBar[]; forbidden: boolean }> {
  const out: AlpacaBar[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const qs = barsQuery(timeframe, startISO, endISO, limitPerPage, feed, pageToken);
    const res = await alpacaFetch(
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs}`
    );
    if (!res.ok) {
      if (res.status === 403) return { bars: out, forbidden: true };
      throw new Error(`alpaca bars failed for ${symbol}: ${res.status}`);
    }
    const data = (await res.json()) as {
      bars?: AlpacaBar[];
      next_page_token?: string | null;
    };
    if (Array.isArray(data.bars)) out.push(...data.bars);
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken && ++pages < 6);
  return { bars: out, forbidden: false };
}

export async function getAlpacaBars(
  symbol: string,
  timeframe: AlpacaTimeframe,
  startISO: string,
  endISO: string,
  limitPerPage = 10_000
): Promise<AlpacaBar[]> {
  const chain = barsFeedChain();
  for (let f = 0; f < chain.length; f++) {
    const { bars, forbidden } = await fetchBarsForFeed(
      symbol,
      timeframe,
      startISO,
      endISO,
      chain[f],
      limitPerPage
    );
    if (forbidden) {
      if (f < chain.length - 1) continue;
      throw new Error(`alpaca bars failed for ${symbol}: 403`);
    }
    return bars;
  }
  return [];
}

export async function getAlpacaBarsLive(
  symbol: string,
  timeframe: AlpacaTimeframe,
  startISO: string,
  endISO: string,
  limitPerPage = 10_000
): Promise<AlpacaBar[]> {
  const base = await getAlpacaBars(symbol, timeframe, startISO, endISO, limitPerPage);

  if (ALPACA_HISTORICAL_FEED !== "sip" || base.length === 0) return base;

  const lastMs = Date.parse(base[base.length - 1].t);
  if (!Number.isFinite(lastMs)) return base;

  const age = Date.now() - lastMs;
  if (age < 5 * 60 * 1000 || age > 3 * 60 * 60 * 1000) return base;

  try {
    const { bars: tail } = await fetchBarsForFeed(
      symbol,
      timeframe,
      new Date(lastMs + 1).toISOString(),
      endISO,
      "iex",
      limitPerPage
    );
    const merged = base.slice();
    for (const b of tail) {
      if (Date.parse(b.t) > lastMs) merged.push(b);
    }
    return merged;
  } catch (error) {
    console.error(`[alpaca] live tail failed for ${symbol}:`, error);
    return base;
  }
}

export async function getAlpacaMultiBars(
  symbols: string[],
  timeframe: AlpacaTimeframe,
  startISO: string,
  endISO: string,
  limitPerPage = 10_000
): Promise<Record<string, AlpacaBar[]>> {
  if (symbols.length === 0) return {};

  const chain = barsFeedChain();
  for (let f = 0; f < chain.length; f++) {
    const feed = chain[f];
    const out: Record<string, AlpacaBar[]> = {};
    let pageToken: string | undefined;
    let pages = 0;
    let downgrade = false;
    do {
      const params = new URLSearchParams({
        symbols: symbols.join(","),
        timeframe,
        start: startISO,
        end: clampEnd(endISO, feed),
        limit: String(limitPerPage),
        adjustment: "all",
        feed,
        sort: "asc",
      });
      if (pageToken) params.set("page_token", pageToken);
      const res = await alpacaFetch(`/v2/stocks/bars?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 403 && f < chain.length - 1) {
          downgrade = true;
          break;
        }
        throw new Error(`alpaca multi-bars failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        bars?: Record<string, AlpacaBar[]>;
        next_page_token?: string | null;
      };
      for (const [sym, bars] of Object.entries(data.bars ?? {})) {
        (out[sym] ??= []).push(...bars);
      }
      pageToken = data.next_page_token ?? undefined;
    } while (pageToken && ++pages < 12);
    if (!downgrade) return out;
  }
  return {};
}

export type AlpacaBarLite = {
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  n?: number;
};

export type AlpacaSnapshot = {
  latestTrade?: { p?: number };
  minuteBar?: AlpacaBarLite;
  dailyBar?: AlpacaBarLite;
  prevDailyBar?: AlpacaBarLite;
};

export type AlpacaMarketMover = {
  symbol: string;
  price: number;
  change: number;
  percentChange: number;
};

export type AlpacaMarketMovers = {
  gainers: AlpacaMarketMover[];
  losers: AlpacaMarketMover[];
  lastUpdated?: string;
};

export async function getAlpacaMarketMovers(
  top = 5
): Promise<AlpacaMarketMovers> {
  const limit = Math.max(1, Math.min(50, Math.trunc(top)));
  const res = await alpacaFetch(
    `/v1beta1/screener/stocks/movers?top=${limit}`
  );
  if (!res.ok) {
    throw new Error(`alpaca market movers failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    gainers?: Array<{
      symbol?: unknown;
      price?: unknown;
      change?: unknown;
      percent_change?: unknown;
    }>;
    losers?: Array<{
      symbol?: unknown;
      price?: unknown;
      change?: unknown;
      percent_change?: unknown;
    }>;
    last_updated?: unknown;
  };
  const normalize = (
    rows: typeof data.gainers
  ): AlpacaMarketMover[] =>
    (rows ?? []).flatMap((row) => {
      if (
        typeof row.symbol !== "string" ||
        typeof row.price !== "number" ||
        typeof row.change !== "number" ||
        typeof row.percent_change !== "number" ||
        !Number.isFinite(row.price) ||
        !Number.isFinite(row.change) ||
        !Number.isFinite(row.percent_change)
      ) {
        return [];
      }
      return [
        {
          symbol: row.symbol.toUpperCase(),
          price: row.price,
          change: row.change,
          percentChange: row.percent_change,
        },
      ];
    });
  return {
    gainers: normalize(data.gainers),
    losers: normalize(data.losers),
    ...(typeof data.last_updated === "string"
      ? { lastUpdated: data.last_updated }
      : {}),
  };
}

export async function getAlpacaSnapshots(
  symbols: string[]
): Promise<Record<string, AlpacaSnapshot>> {
  const out: Record<string, AlpacaSnapshot> = {};
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
  if (unique.length === 0) return out;

  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const params = new URLSearchParams({
      symbols: chunk.join(","),
      feed: ALPACA_FEED,
    });
    const res = await alpacaFetch(`/v2/stocks/snapshots?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`alpaca snapshots failed: ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const map = (
      data && typeof data === "object" && "snapshots" in data
        ? (data as { snapshots: Record<string, AlpacaSnapshot> }).snapshots
        : (data as Record<string, AlpacaSnapshot>)
    ) as Record<string, AlpacaSnapshot>;
    for (const [sym, snap] of Object.entries(map)) {
      if (sym === "next_page_token" || sym === "currency") continue;
      if (snap && typeof snap === "object") out[sym] = snap;
    }
  }
  return out;
}

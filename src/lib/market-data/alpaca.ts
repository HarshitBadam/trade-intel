import "server-only";

import {
  ALPACA_API_KEY_ID,
  ALPACA_API_SECRET_KEY,
  ALPACA_FEED,
  ALPACA_HISTORICAL_FEED,
} from "@/lib/config";
import { slidingLimiter } from "./limiter";

// Alpaca Market Data lives on its own host (data.alpaca.markets), separate from
// the trading API. Free accounts get a ~200 req/min limit and deep history.
// Historical bars use the SIP feed (100% of US volume) — free for any window
// ending >=15 min ago; snapshots are locked to IEX (~2.5% of volume) on the free
// plan, so their volume is corrected downstream from SIP daily bars.
const DATA_BASE = "https://data.alpaca.markets";

// Stay comfortably under the 200/min free limit; see limiter.ts for why this is
// mostly a burst smoother rather than a hard budget.
const acquire = slidingLimiter(180, 60_000);

// SIP historical data is free only for windows ending >=15 min ago (a request
// touching more recent SIP data 403s without Algo Trader Plus). Pad to 16 min to
// stay clear of the boundary; IEX has no such restriction.
const SIP_MIN_DELAY_MS = 16 * 60 * 1000;

// SIP (full-market volume) is the default for history; IEX is the guaranteed
// floor. If an account isn't entitled to SIP history it 403s, so we transparently
// retry on IEX rather than letting the fetch fail through to Polygon/mock.
function barsFeedChain(): string[] {
  return ALPACA_HISTORICAL_FEED === "sip"
    ? ["sip", "iex"]
    : [ALPACA_HISTORICAL_FEED];
}

// Clamp a SIP request's end to >=15 min ago so it never trips the free-plan
// "recent SIP" 403. IEX (and windows that already end in the past) pass through.
function clampEnd(endISO: string, feed: string): string {
  if (feed !== "sip") return endISO;
  const end = Date.parse(endISO);
  const maxEnd = Date.now() - SIP_MIN_DELAY_MS;
  return Number.isFinite(end) && end > maxEnd
    ? new Date(maxEnd).toISOString()
    : endISO;
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
  });
}

// One OHLCV bar as returned by /v2/stocks bars endpoints. `t` is RFC3339, `v` is
// share volume, `n` is the trade count, `vw` is VWAP.
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

// Pages a SINGLE given feed to completion for one symbol. Follows
// `next_page_token` so a long/fine window returns complete data; capped at 6
// pages so a pathological token loop can't hang a render. Returns the collected
// bars plus a `forbidden` flag (set on a 403) so the caller can decide whether
// to downgrade to another feed — this keeps the feed-selection policy out of
// the paging loop, letting both the SIP→IEX downgrade chain and the live IEX
// tail reuse the exact same paging logic.
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
      // A 403 means "not entitled to this feed" — surface it so the caller can
      // fall back to another feed. Any other status is a real failure and
      // throws so the caller's cache doesn't pin it (can fall back to Polygon).
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

// Historical bars for ONE symbol. Prefers SIP (full-market volume) and
// downgrades to IEX on a 403 (no SIP entitlement). Throws on any other non-OK
// status so the caller's cache doesn't pin the failure and can fall back to
// Polygon.
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
      // Downgrade to the next feed in the chain; if this was the last feed,
      // there's nothing left to try, so surface the 403 as a failure.
      if (f < chain.length - 1) continue;
      throw new Error(`alpaca bars failed for ${symbol}: 403`);
    }
    return bars;
  }
  return [];
}

// Like getAlpacaBars, but stitches a live IEX tail onto the SIP base so a
// sub-daily series reaches ~now instead of stopping ~16 min back. SIP history
// is free only for windows ending >=15 min ago (clampEnd forces the end back),
// which leaves a visible hole at the right edge of the 1D/fine chart during an
// active session. IEX has no such clamp, so we fill ONLY those trailing minutes
// SIP withholds — SIP stays the accurate base for volume/history. Best-effort:
// a failed tail never breaks the series, it just returns the SIP base.
export async function getAlpacaBarsLive(
  symbol: string,
  timeframe: AlpacaTimeframe,
  startISO: string,
  endISO: string,
  limitPerPage = 10_000
): Promise<AlpacaBar[]> {
  const base = await getAlpacaBars(symbol, timeframe, startISO, endISO, limitPerPage);

  // Only SIP is clamped. If the configured feed is already IEX the base is
  // real-time, and with no base bars there's no gap to reason about.
  if (ALPACA_HISTORICAL_FEED !== "sip" || base.length === 0) return base;

  const lastMs = Date.parse(base[base.length - 1].t);
  if (!Number.isFinite(lastMs)) return base;

  // Only bridge a genuine live SIP-clamp gap: last bar 5 min–3 h behind now.
  // Fresher than 5 min means SIP is effectively live already (nothing to add);
  // older than 3 h means the market is closed, so IEX would return nothing
  // useful — either way a tail request would just be wasted.
  const age = Date.now() - lastMs;
  if (age < 5 * 60 * 1000 || age > 3 * 60 * 60 * 1000) return base;

  try {
    // Fetch the IEX tail starting just after the last SIP bar through the same
    // end (IEX isn't clamped, so it returns right up to ~now).
    const { bars: tail } = await fetchBarsForFeed(
      symbol,
      timeframe,
      new Date(lastMs + 1).toISOString(),
      endISO,
      "iex",
      limitPerPage
    );
    // Append only strictly-newer bars (dedupe against the base). NOTE: these
    // final bars carry IEX (~2.5% of volume) rather than SIP full-market
    // volume — acceptable because it's just the last few live minutes, and far
    // better than a visible ~16-minute hole at the right edge of the chart.
    const merged = base.slice();
    for (const b of tail) {
      if (Date.parse(b.t) > lastMs) merged.push(b);
    }
    return merged;
  } catch (error) {
    // Best-effort enhancement: never fail the whole series because the live
    // tail couldn't be fetched — return the accurate SIP base unchanged.
    console.error(`[alpaca] live tail failed for ${symbol}:`, error);
    return base;
  }
}

// Multi-symbol bars. The endpoint sorts by symbol first, then timestamp, so a
// single symbol can fill the page limit — we page until exhausted and merge by
// symbol. Used for the year-ago close map (a short daily window across the known
// universe), where the total row count fits comfortably in one or two pages.
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

// A snapshot bundles the latest trade/quote plus today's and yesterday's daily
// bar — everything needed to derive a live quote (price, day change, volume) in
// a single multi-symbol request.
export type AlpacaSnapshot = {
  latestTrade?: { p?: number };
  minuteBar?: AlpacaBarLite;
  dailyBar?: AlpacaBarLite;
  prevDailyBar?: AlpacaBarLite;
};

// Latest snapshots for many symbols in one request (chunked to keep URLs sane).
// The v2 response is keyed directly by symbol; we defensively skip any
// envelope-style keys. Throws on a non-OK status so the caller can fall back.
export async function getAlpacaSnapshots(
  symbols: string[]
): Promise<Record<string, AlpacaSnapshot>> {
  const out: Record<string, AlpacaSnapshot> = {};
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(
    Boolean
  );
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
    // Most deployments key the map directly by symbol; tolerate a `snapshots`
    // envelope just in case.
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

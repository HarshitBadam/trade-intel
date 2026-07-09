import "server-only";

import { unstable_cache } from "next/cache";
import { News } from "@/components/news/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import {
  FALLBACK_TICKERS,
  CRON_WARMUP_TICKERS,
  CURATED_PEERS,
} from "@/data/fallbacks";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
  hasAlpaca,
  hasFinnhub,
  hasPolygon,
} from "@/lib/config";
import {
  mapPolygonAggs,
  mapAlpacaBars,
  mapAlpacaSnapshotQuote,
  type PolygonAggBar,
} from "./transforms";
import { polygonFetch } from "./polygon";
import { readAnalysisDoc, readTickerArticles } from "./news-store";
import {
  getAlpacaBars,
  getAlpacaBarsLive,
  getAlpacaMultiBars,
  getAlpacaSnapshots,
  type AlpacaTimeframe,
} from "./alpaca";
import { finnhubSearch, finnhubProfile, finnhubPeers } from "./finnhub";
import type {
  SearchResult,
  LiveQuote,
  TickerDetail,
  Mover,
  BarPoint,
  StoredArticle,
  AnalysisDoc,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (ms: number) => new Date(ms).toISOString();

const MOVER_NAMES = new Map(FALLBACK_TICKERS.map((t) => [t.ticker, t.name]));
const MOVER_SYMBOLS = FALLBACK_TICKERS.map((t) => t.ticker);
const MOVER_SYMBOL_SET = new Set(MOVER_SYMBOLS);
type GroupedRow = { T: string; o: number; c: number; v: number };

// The bounded symbol universe the Alpaca snapshot market-map covers (Alpaca
// can't return "the whole market" the way Polygon's grouped-daily does, so we
// enumerate the tickers the home/related surfaces actually render: movers,
// cron warm set, and every curated peer). Deliberately NOT the full search
// universe (~12.5k names) — that would balloon one snapshot into ~126 chunked
// calls; details pages quote arbitrary symbols via getQuotesForCached instead.
// Polygon's grouped-daily fallback still covers the entire market when Alpaca
// isn't configured.
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

// The grouped-daily walk-back exists for weekends/holidays (empty days), so it
// must only advance on a genuinely empty OK response. An error (429/403/5xx)
// would fail for every prior day too — continuing would just burn 5 more
// requests from the shared budget. Throwing also keeps unstable_cache from
// pinning the failure for the whole revalidate window.
function assertPolygonOk(response: Response, what: string): void {
  if (response.ok) return;
  console.error(
    `[polygon] ${what} fetch failed: ${response.status} ${response.statusText}`
  );
  throw new Error(`polygon ${what} failed: ${response.status}`);
}

// Shared price-bar fetcher with the PREFERRED→FALLBACK chain: Alpaca (real-time
// IEX, deep history) → Polygon aggregates → (nothing; caller handles mock in
// demo mode). Both providers return `v`/`n`, so the resulting BarPoints always
// carry volume/trades. Throws when the configured providers all fail so
// unstable_cache doesn't pin the failure (the caller retries next render).
async function fetchBarsChain(
  ticker: string,
  alpacaTimeframe: AlpacaTimeframe,
  fromMs: number,
  toMs: number,
  polygonUrl: string,
  liveTail = false
): Promise<BarPoint[]> {
  let alpacaFailed = false;
  if (hasAlpaca) {
    try {
      // Sub-daily series (1D/fine) pass liveTail so the SIP base gets a live
      // IEX tail up to ~now; daily series keep the plain SIP fetch (a ~16-min
      // gap is invisible on a multi-year chart, and its headline price is made
      // real-time separately in getCandlesCached).
      const raw = liveTail
        ? await getAlpacaBarsLive(ticker, alpacaTimeframe, isoTime(fromMs), isoTime(toMs))
        : await getAlpacaBars(ticker, alpacaTimeframe, isoTime(fromMs), isoTime(toMs));
      const bars = mapAlpacaBars(raw);
      if (bars.length >= 2 || !hasPolygon) return bars;
    } catch (error) {
      alpacaFailed = true;
      console.error(
        `[alpaca] ${alpacaTimeframe} bars failed for ${ticker}:`,
        error
      );
    }
  }
  if (hasPolygon) {
    const response = await polygonFetch(polygonUrl);
    if (!response.ok) {
      console.error(
        `[polygon] bars fetch failed for ${ticker}: ${response.status} ${response.statusText}`
      );
      throw new Error(`polygon bars failed: ${response.status}`);
    }
    const data = await response.json();
    return mapPolygonAggs((data.results ?? []) as PolygonAggBar[]);
  }
  if (alpacaFailed) {
    throw new Error(`bars failed for ${ticker} with no available fallback`);
  }
  return [];
}

// Snapshots are IEX-only on Alpaca's free plan (~2.5% of US volume), so every
// snapshot-derived "Volume" and the liquidity-based Key Reason ran 10-30x light
// — and because the IEX share differs per name, the RATIOS between two stocks
// were distorted too, not just the absolute numbers. SIP daily bars carry the
// full-market volume and are free for windows ending >=15 min ago (the Alpaca
// layer clamps automatically), so we source the current session's true volume
// here and overlay it onto snapshot quotes. Best-effort: a miss leaves the
// (real, if undercounted) IEX figure untouched rather than blanking a card.
async function fetchSessionVolumes(
  symbolsKey: string
): Promise<Record<string, number>> {
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

const getSessionVolumesForCached = unstable_cache(
  fetchSessionVolumes,
  ["session-volumes"],
  { revalidate: 300, tags: ["movers"] }
);

// Merge full-market SIP session volume onto snapshot quotes, in place. The
// volumes are fetched in PARALLEL with the snapshot by the caller (both take the
// same symbol set), so this is a pure, synchronous overlay — no extra round-trip
// sits on the critical path of the market map or related-stock cards.
function applySessionVolumes(
  quotes: Record<string, LiveQuote>,
  vols: Record<string, number>
): Record<string, LiveQuote> {
  for (const s of Object.keys(quotes)) {
    const v = vols[s];
    if (typeof v === "number" && v > 0) quotes[s].volume = v;
  }
  return quotes;
}

// Sorted, comma-joined symbol key for the session-volume cache — stable across
// callers so identical symbol sets share a cache entry.
function volumeKey(symbols: string[]): string {
  return [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(",");
}

// Home movers: Alpaca multi-symbol snapshot over the known movers → Polygon
// grouped-daily (whole market, walked back over holidays) → null (caller mocks).
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
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmtDay(
          day
        )}?adjusted=true`
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

// Multi-ticker quote map: Alpaca snapshot over the known universe → Polygon
// grouped-daily (whole market) → {}. Powers home live quotes, the quote
// fallback, and related-stock cards.
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
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmtDay(
          day
        )}?adjusted=true`
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

// Year-ago close per symbol, used to rank related stocks by 1Y return. Alpaca:
// a short daily window ~1 year back across the known universe (earliest close in
// window). Polygon: grouped-daily walked back ~1 year. Either may be empty, in
// which case related ranking falls back to the daily % move.
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
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${fmtDay(
          day
        )}?adjusted=true`
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

// Daily candles (~2y). Clamped to ~2y so the Polygon fallback stays inside the
// free tier's aggregate window (a 5y request 403s there); Alpaca is fine either
// way. Returns the close series plus a summary + the latest daily volume (reused
// by the popularity card so no extra request is spent on it).
async function fetchCandles(ticker: string) {
  const to = Date.now();
  const from = to - 2 * 365 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const bars = await fetchBarsChain(ticker, "1Day", from, to, polygonUrl);
  if (bars.length < 2) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const result = {
    chart_data: bars,
    stock_price: last.value,
    price_change: last.value - prev.value,
    percent_change: ((last.value - prev.value) / prev.value) * 100,
    latest_volume:
      typeof last.volume === "number" ? Math.round(last.volume) : null,
  };

  // The daily bars are SIP, so the headline price lags ~16 min during market
  // hours (unlike the sub-daily charts, daily bars aren't worth tail-filling
  // — a 16-min gap is invisible on a multi-year line). Instead, best-effort
  // override just the scalar price fields with the real-time IEX snapshot,
  // refreshed each 5-min cache window. chart_data/latest_volume stay
  // SIP-derived (full-market volume stays accurate); the snapshot's change is
  // measured vs the previous daily close, matching the day-change semantics.
  if (hasAlpaca) {
    try {
      const snaps = await getAlpacaSnapshots([ticker]);
      const quote = mapAlpacaSnapshotQuote(ticker, snaps[ticker]);
      if (quote && quote.price > 0) {
        result.stock_price = quote.price;
        result.price_change = quote.change;
        result.percent_change = quote.percentChange;
      }
    } catch (error) {
      console.error(`[alpaca] headline snapshot failed for ${ticker}:`, error);
    }
  }

  return result;
}

export const getCandlesCached = unstable_cache(fetchCandles, ["candles"], {
  revalidate: 300,
  tags: ["candles"],
});

async function fetchAstraNews(ticker: string): Promise<News[]> {
  const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
  const database = client.db(ASTRA_DB_API_ENDPOINT!);
  const table = database.collection<News>(ASTRA_DB_NEWS_COLLECTION);
  return table.find({ "metadata.ticker": ticker }).toArray();
}

export const getNewsCached = unstable_cache(fetchAstraNews, ["astra-news"], {
  revalidate: 600,
  tags: ["news"],
});

// ─── Store-first request path (redesign §5) ──────────────────────────────────
// The details news/sentiment panel reads a ticker's stored article rows and its
// analysis verdict THROUGH these cached wrappers (tag "news", 10-min revalidate)
// and never touches a provider at request time. The cron and priority store
// lanes tag their writes "news", so a revalidateTag("news") busts these the
// moment fresh articles land or a verdict is written.
async function readStoredTickerArticles(ticker: string): Promise<StoredArticle[]> {
  return readTickerArticles(ticker, 200);
}

export const readStoredArticlesCached = unstable_cache(
  readStoredTickerArticles,
  ["store-ticker-articles"],
  { revalidate: 600, tags: ["news"] }
);

async function readTickerAnalysis(ticker: string): Promise<AnalysisDoc | null> {
  return readAnalysisDoc(ticker);
}

export const readAnalysisDocCached = unstable_cache(
  readTickerAnalysis,
  ["store-analysis-doc"],
  { revalidate: 600, tags: ["news"] }
);

// 1-minute intraday over the last few sessions, sliced to the latest session for
// the 1D view. Alpaca (real-time IEX) → Polygon 1-min aggregates.
async function fetchIntraday(ticker: string): Promise<BarPoint[] | null> {
  const to = Date.now();
  const from = to - 5 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const bars = await fetchBarsChain(ticker, "1Min", from, to, polygonUrl, true);
  if (bars.length < 2) return null;

  const lastDay = bars[bars.length - 1].date.slice(0, 10);
  const session = bars.filter((b) => b.date.slice(0, 10) === lastDay);
  return session.length >= 2 ? session : bars;
}

export const getIntradayCached = unstable_cache(fetchIntraday, ["intraday-1m"], {
  revalidate: 300,
  tags: ["candles"],
});

// "Fine" 15-minute bars power 1W/1M/3M as a dense line. ~92 days is capped so the
// Polygon fallback stays under its 50k-result cap and inside the free window.
// Alpaca (15Min) → Polygon 15-min aggregates.
async function fetchFine(ticker: string): Promise<BarPoint[] | null> {
  const to = Date.now();
  const from = to - 96 * DAY_MS;
  const polygonUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/15/minute/${fmtDay(
    new Date(from)
  )}/${fmtDay(new Date(to))}?adjusted=true&sort=asc&limit=50000`;

  const bars = await fetchBarsChain(ticker, "15Min", from, to, polygonUrl, true);
  if (bars.length < 2) return null;

  const latest = Date.parse(bars[bars.length - 1].date);
  const cutoff = latest - 92 * DAY_MS;
  const recent = bars.filter((b) => Date.parse(b.date) >= cutoff);
  return recent.length >= 2 ? recent : bars;
}

export const getFineCached = unstable_cache(fetchFine, ["fine-15m"], {
  revalidate: 300,
  tags: ["candles"],
});

// Quotes for an ARBITRARY, exact symbol set (e.g. a peer group Finnhub just
// returned) — deliberately independent of KNOWN_UNIVERSE. The curated-universe
// snapshot above is right for movers (a fixed, known set), but a related-stock
// peer can be any US ticker; intersecting it with a static list would silently
// drop real peers forever as soon as they fall outside that list. Alpaca has
// no "whole market" snapshot, so instead we snapshot exactly the symbols asked
// for. Polygon's fallback IS whole-market already, so it can reuse the shared
// map. Cached per unique (sorted) symbol set, which for a peer group of ~5
// tickers is cheap and — unlike the curated list — always correct.
async function fetchQuotesFor(
  symbolsKey: string
): Promise<Record<string, LiveQuote>> {
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
    const whole = await getMarketMapCached().catch(
      () => ({}) as Record<string, LiveQuote>
    );
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

// Year-ago close for an ARBITRARY, exact symbol set — same rationale as
// getQuotesForCached above (a peer group is never bounded to KNOWN_UNIVERSE).
async function fetchYearAgoQuotesFor(
  symbolsKey: string
): Promise<Record<string, number>> {
  const symbols = symbolsKey.split(",").filter(Boolean);
  if (symbols.length === 0) return {};
  if (hasAlpaca) {
    try {
      const start = isoTime(Date.now() - 372 * DAY_MS);
      const end = isoTime(Date.now() - 358 * DAY_MS);
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
      console.error(
        "[alpaca] targeted year-ago quotes failed, trying Polygon:",
        error
      );
    }
  }
  if (hasPolygon) {
    const whole = await getMarketMapYearAgoCached().catch(
      () => ({}) as Record<string, number>
    );
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

// Backstop ceiling on market cap. Finnhub reports foreign caps in the LOCAL
// currency (see below), which inflates them well past any real company (largest
// is ~$5T). The primary guard is the currency check; this only catches a stray
// USD-labelled-but-absurd value from either provider.
const MAX_PLAUSIBLE_MARKET_CAP = 1e13; // $10T

function saneMarketCap(v: number | null | undefined): number | null {
  return typeof v === "number" && v > 0 && v <= MAX_PLAUSIBLE_MARKET_CAP
    ? v
    : null;
}

// Finnhub's marketCapitalization is denominated in the profile's `currency`.
// Foreign ADRs report it in the home currency (TSM→TWD, Toyota→JPY, Novo→DKK,
// Infosys→INR), which is 4-100x inflated as USD — and cases like NVO ($1.4T) and
// WIT ($1.9T) sit UNDER the $10T ceiling, so the ceiling alone can't catch them.
// Only trust the cap when it's explicitly USD; otherwise drop it so it can't
// drive a bogus "Similar Market Cap" pairing (the peer still ranks on return).
function usdMarketCap(
  cap: number | null | undefined,
  currency: string | undefined
): number | null {
  if (currency && currency.toUpperCase() !== "USD") return null;
  return saneMarketCap(cap);
}

// Company profile (name / market cap / sector): Finnhub /stock/profile2
// (marketCapitalization is in millions → ×1e6) → Polygon ticker-detail. Finnhub
// has no SIC code, so related-industry matching falls back to the sector string.
async function fetchTickerDetail(ticker: string): Promise<TickerDetail | null> {
  if (hasFinnhub) {
    try {
      const p = await finnhubProfile(ticker);
      if (p) {
        const industry =
          p.finnhubIndustry && p.finnhubIndustry !== "N/A"
            ? p.finnhubIndustry
            : null;
        return {
          ticker,
          name: p.name ?? ticker,
          sicCode: null,
          sector: industry,
          marketCap:
            typeof p.marketCapitalization === "number"
              ? usdMarketCap(p.marketCapitalization * 1e6, p.currency)
              : null,
        };
      }
    } catch (error) {
      console.error(`[finnhub] profile failed for ${ticker}:`, error);
      if (!hasPolygon) throw error;
    }
  }
  if (hasPolygon) {
    const response = await polygonFetch(
      `https://api.polygon.io/v3/reference/tickers/${ticker}`
    );
    // 404 means the ticker genuinely has no reference entry — cache that. Any
    // other failure is transient; throw so a 429 isn't pinned as null for 24h.
    if (response.status === 404) return null;
    assertPolygonOk(response, `ticker detail (${ticker})`);
    const data = await response.json();
    const r = data.results;
    if (!r) return null;
    return {
      ticker,
      name: r.name ?? ticker,
      sicCode: r.sic_code ? String(r.sic_code) : null,
      sector: r.sic_description ?? null,
      marketCap: saneMarketCap(r.market_cap),
    };
  }
  return null;
}

export const getTickerDetailCached = unstable_cache(
  fetchTickerDetail,
  ["ticker-detail"],
  { revalidate: 86_400, tags: ["fundamentals"] }
);

// Peers: Finnhub /stock/peers → Polygon related-companies → [] (caller uses
// curated peers). A transient provider error throws (not pinned) so the next
// render retries; a legitimately empty peer list falls through.
async function fetchRelatedTickers(ticker: string): Promise<string[]> {
  const symbol = ticker.toUpperCase();
  if (hasFinnhub) {
    try {
      const peers = await finnhubPeers(ticker);
      const cleaned = peers
        .map((p) => p.toUpperCase())
        .filter((p) => p && p !== symbol);
      if (cleaned.length > 0) return cleaned;
    } catch (error) {
      console.error(`[finnhub] peers failed for ${ticker}:`, error);
      if (!hasPolygon) throw error;
    }
  }
  if (hasPolygon) {
    const response = await polygonFetch(
      `https://api.polygon.io/v1/related-companies/${ticker}`
    );
    if (!response.ok) {
      throw new Error(`polygon related companies failed: ${response.status}`);
    }
    const data = await response.json();
    const rows = (data.results ?? []) as { ticker?: string }[];
    return rows.map((x) => x.ticker ?? "").filter(Boolean);
  }
  return [];
}

export const getRelatedTickersCached = unstable_cache(
  fetchRelatedTickers,
  ["related-tickers"],
  { revalidate: 86_400, tags: ["fundamentals"] }
);

type FinnhubHitLite = { ticker: string; name: string; type: string };

function finnhubSearchRelevance(hit: FinnhubHitLite, q: string): number {
  const tk = hit.ticker;
  const name = hit.name.toUpperCase();
  let score = 0;
  if (tk === q) score -= 1000;
  if (tk.startsWith(q)) score -= 80;
  else if (tk.includes(q)) score -= 20;
  if (name.startsWith(q)) score -= 30;
  else if (name.includes(q)) score -= 10;
  // Prefer plain common stock over odd instrument types.
  if (hit.type && hit.type !== "Common Stock") score += 50;
  score += tk.length;
  return score;
}

// Live symbol search for the long tail the local universe can't answer:
// Finnhub /search ONLY (fuzzy matching, 60/min), filtered to plausible
// US-listed symbols and ranked locally so exact/prefix matches surface first.
// Callers gate on hasFinnhub and only reach here on ZERO local hits, so this
// is rare. Throws on failure (never returns [] for an outage) so
// unstable_cache doesn't pin the failure for the whole revalidate window and
// the caller can distinguish "search down" from "no matches".
async function fetchTickerSearch(query: string): Promise<SearchResult[]> {
  const q = query.toUpperCase();
  const hits = finnhubSearchToLite(await finnhubSearch(query));
  return hits
    .slice()
    .sort((a, b) => finnhubSearchRelevance(a, q) - finnhubSearchRelevance(b, q))
    .slice(0, 10)
    .map((s) => ({ ticker: s.ticker, name: s.name || s.ticker }));
}

export const searchTickersCached = unstable_cache(
  fetchTickerSearch,
  ["ticker-search"],
  { revalidate: 86_400, tags: ["search"] }
);

// Normalize Finnhub search hits to US-primary equity candidates: drop empty and
// exchange-suffixed foreign symbols (e.g. "AAPL.MX") so the picks stay clean.
function finnhubSearchToLite(
  hits: { description?: string; displaySymbol?: string; symbol?: string; type?: string }[]
): FinnhubHitLite[] {
  const out: FinnhubHitLite[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const ticker = (h.symbol ?? h.displaySymbol ?? "").toUpperCase();
    if (!ticker || ticker.includes(".") || !/^[A-Z]+$/.test(ticker)) continue;
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, name: h.description ?? "", type: h.type ?? "" });
  }
  return out;
}

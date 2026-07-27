import "server-only";

import { unstable_cache } from "next/cache";
import { hasFinnhub, hasPolygon } from "@/lib/config";
import { polygonFetch, assertPolygonOk } from "./polygon";
import { finnhubSearch, finnhubProfile, finnhubPeers } from "./finnhub";
import type { SearchResult, TickerDetail } from "./types";

// Backstop ceiling on market cap. Finnhub reports foreign caps in the LOCAL
// currency (see usdMarketCap), which inflates them well past any real company.
// This catches a stray USD-labelled-but-absurd value from either provider.
const MAX_PLAUSIBLE_MARKET_CAP = 1e13; // $10T

function saneMarketCap(v: number | null | undefined): number | null {
  return typeof v === "number" && v > 0 && v <= MAX_PLAUSIBLE_MARKET_CAP ? v : null;
}

// Finnhub's marketCapitalization is denominated in the profile's `currency`.
// Foreign ADRs report it in the home currency (TSM→TWD, Toyota→JPY, Novo→DKK,
// Infosys→INR), which is 4-100x inflated as USD, and cases like NVO ($1.4T)
// and WIT ($1.9T) sit UNDER the $10T ceiling, so the ceiling alone can't catch
// them. Only trust the cap when it's explicitly USD.
function usdMarketCap(
  cap: number | null | undefined,
  currency: string | undefined
): number | null {
  if (currency && currency.toUpperCase() !== "USD") return null;
  return saneMarketCap(cap);
}

async function fetchTickerDetail(ticker: string): Promise<TickerDetail | null> {
  if (hasFinnhub) {
    try {
      const p = await finnhubProfile(ticker);
      if (p) {
        const industry =
          p.finnhubIndustry && p.finnhubIndustry !== "N/A" ? p.finnhubIndustry : null;
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
    // 404 means the ticker has no reference entry, cache that.
    // Any other failure is transient; throw so a 429 isn't pinned as null for 24h.
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

// Live symbol search for the long tail the local universe can't answer.
// Finnhub /search only (fuzzy matching, 60/min), filtered to plausible
// US-listed symbols and ranked locally so exact/prefix matches surface first.
// Throws on failure (never returns [] for an outage) so unstable_cache
// doesn't pin the failure and the caller can distinguish "search down" from "no matches".
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

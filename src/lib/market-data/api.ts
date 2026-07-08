import "server-only";

import { getCuratedPeers, getGroupPeers } from "@/data/fallbacks";
import { hasAstra, hasAlpaca, hasPolygon } from "@/lib/config";

// Preferred (Alpaca) or fallback (Polygon) price provider. Quotes/movers/related
// prices all require one of these to render real numbers.
const hasPrices = hasAlpaca || hasPolygon;
import type {
  Quote,
  Headline,
  Movers,
  LiveQuote,
  ChatQuote,
  RelatedCard,
  TickerDetail,
  Candidate,
} from "./types";
import {
  sanitizeTicker,
  mockQuote,
  newsToHeadline,
  pickTopArticle,
  mockHeadline,
  mockMovers,
  summarizeMovers,
  relatedData,
  buildRelationInsight,
  type RelationStats,
} from "./transforms";
import {
  getGroupedDailyCached,
  getMarketMapCached,
  getQuotesForCached,
  getYearAgoQuotesForCached,
  getCandlesCached,
  getNewsCached,
  getTickerNewsCached,
  getTickerDetailCached,
  getRelatedTickersCached,
} from "./cache";
import {
  getStockCandles,
  getIntraday,
  getFine,
  weekFromFine,
} from "./queries";
import { generateMockWeek } from "@/data/fallbacks";

export async function getMoversData(): Promise<Movers> {
  if (hasPrices) {
    try {
      const live = await getGroupedDailyCached();
      if (live && live.length > 0) return summarizeMovers(live);
    } catch (error) {
      console.error("Movers fetch failed, using fallback:", error);
    }
  }
  return summarizeMovers(mockMovers());
}

export async function getQuoteData(ticker: string): Promise<Quote> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockQuote("N/A");

  // 1W is sliced from the fine series rather than fetched, and the two must
  // not race each other into a duplicate cold fetch — so fine is fetched once.
  const [stock_data, intraday, fine] = await Promise.all([
    getStockCandles(symbol),
    getIntraday(symbol),
    getFine(symbol),
  ]);
  const week = hasPrices ? weekFromFine(fine) : generateMockWeek(symbol);

  if (!stock_data) {
    // Live mode, candles transiently failed: fall back to the shared market
    // map (real end-of-day quote, cached hourly) rather than fabricating a
    // price. Empty series render as an honest empty chart.
    const quote = await getMarketMapCached()
      .then((m) => m[symbol])
      .catch(() => undefined);
    return {
      ticker: symbol,
      stockPrice: quote?.price ?? 0,
      priceChange: quote?.change ?? 0,
      percentChange: quote?.percentChange ?? 0,
      chartData: [],
      intradayData: intraday,
      weekData: week,
      fineData: fine,
    };
  }

  return {
    ticker: symbol,
    stockPrice: stock_data.stock_price,
    priceChange: stock_data.price_change,
    percentChange: stock_data.percent_change,
    chartData: stock_data.chart_data,
    intradayData: intraday,
    weekData: week,
    fineData: fine,
  };
}

export async function getHeadlineData(ticker: string): Promise<Headline> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockHeadline("AAPL");

  if (hasAstra) {
    try {
      const news = await getNewsCached(symbol);
      if (news.length > 0) return newsToHeadline(symbol, pickTopArticle(news));
    } catch (error) {
      console.error("Astra headline fetch failed, trying Polygon:", error);
    }
  }
  if (hasPolygon) {
    try {
      const news = await getTickerNewsCached(symbol);
      if (news.length > 0) return newsToHeadline(symbol, news[0]);
    } catch (error) {
      console.error("Polygon headline fetch failed, using fallback:", error);
    }
  }
  return mockHeadline(symbol);
}

export async function getLiveQuotes(tickers: string[]): Promise<LiveQuote[]> {
  if (!hasPrices || tickers.length === 0) return [];
  try {
    const map = await getMarketMapCached();
    const seen = new Set<string>();
    const out: LiveQuote[] = [];
    for (const raw of tickers) {
      const t = raw.toUpperCase();
      if (seen.has(t)) continue;
      seen.add(t);
      if (map[t]) out.push(map[t]);
    }
    return out.slice(0, 4);
  } catch (error) {
    console.error("Live quote lookup failed:", error);
    return [];
  }
}

export async function getChatQuotes(tickers: string[]): Promise<ChatQuote[]> {
  if (!hasPrices || tickers.length === 0) return [];
  const uniq = [...new Set(tickers.map((t) => t.toUpperCase()))].slice(0, 3);

  const quotes = await Promise.all(
    uniq.map(async (ticker): Promise<ChatQuote | null> => {
      try {
        const c = await getCandlesCached(ticker);
        if (!c || c.chart_data.length < 2) return null;
        const closes = c.chart_data.map((d) => d.value);
        const i = closes.length - 1;
        const pctBack = (sessions: number): number | null => {
          const j = i - sessions;
          return j >= 0 && closes[j] > 0
            ? ((closes[i] - closes[j]) / closes[j]) * 100
            : null;
        };
        return {
          ticker,
          price: c.stock_price,
          dayPct: c.percent_change,
          weekPct: pctBack(5),
          monthPct: pctBack(21),
          yearPct: pctBack(252),
        };
      } catch {
        return null;
      }
    })
  );

  return uniq
    .map((t) => quotes.find((q) => q && q.ticker === t))
    .filter((q): q is ChatQuote => Boolean(q));
}

// Final count of peer cards' worth of candidates. Each surviving peer costs one
// (24h-cached) ticker-detail request; 3 cards need at most this many to choose
// from. The wider pool below is only quote-filtered (one batched snapshot), so
// raising this is cheap on candidate discovery but not on detail lookups.
const MAX_PEERS = 4;
// Upper bound on the pre-filter candidate pool. Bounds the single batched
// snapshot that decides chartability; comfortably fits a cohort plus the live
// feed plus the curated map.
const PEER_POOL_MAX = 18;

export async function getRelatedStocksData(
  ticker: string
): Promise<RelatedCard[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol || !hasPrices) return [];

  try {
    // Isolated so a transient failure (now thrown, no longer cached) still
    // falls through to the curated sources instead of aborting the request.
    let relatedTickers: string[] = [];
    try {
      relatedTickers = await getRelatedTickersCached(symbol);
    } catch (error) {
      console.error("Related companies lookup failed, using peers:", error);
    }

    const clean = (list: string[]) =>
      list.map(sanitizeTicker).filter((t) => t && t !== symbol);

    // Candidate pool, highest-quality source first: hand-curated sector cohort
    // (on-topic, chartable), then the live peer feed, then the legacy per-ticker
    // map. Deduped and bounded. Sourcing the cohort first is what keeps names
    // like TEAM (whose live peers are mostly unchartable ASX listings) on-topic.
    const pool = Array.from(
      new Set([
        ...clean(getGroupPeers(symbol)),
        ...clean(relatedTickers),
        ...clean(getCuratedPeers(symbol)),
      ])
    ).slice(0, PEER_POOL_MAX);

    if (pool.length === 0) return [];

    // Decide chartability BEFORE capping: one batched snapshot over the whole
    // pool, keep only peers our price provider can actually quote, THEN take the
    // top MAX_PEERS. Previously we capped first, so unchartable peers (foreign
    // listings, illiquid names) burned the display slots and left the section
    // half-empty. Keyed on the sorted set so it stays correct for any ticker.
    const poolKey = [...new Set([symbol, ...pool])].sort().join(",");
    const marketMap = await getQuotesForCached(poolKey).catch(
      () => ({}) as Record<string, LiveQuote>
    );

    const peerTickers = pool.filter((t) => marketMap[t]).slice(0, MAX_PEERS);
    if (peerTickers.length === 0) return [];

    // Year-ago closes and profiles only for the final, chartable selection.
    const finalKey = [...new Set([symbol, ...peerTickers])].sort().join(",");
    const [yearAgoMap, currentDetail, peerDetails] = await Promise.all([
      getYearAgoQuotesForCached(finalKey).catch(
        () => ({}) as Record<string, number>
      ),
      getTickerDetailCached(symbol).catch(() => null as TickerDetail | null),
      Promise.all(
        peerTickers.map((t) =>
          getTickerDetailCached(t).catch(() => null as TickerDetail | null)
        )
      ),
    ]);

    const returnOf = (t: string): number | null => {
      const now = marketMap[t]?.price;
      const ago = yearAgoMap[t];
      return now && ago ? (now / ago - 1) * 100 : null;
    };

    // Only peers with a live quote become candidates: a card must never show
    // invented prices. If the market map is unavailable this yields zero
    // candidates and the section simply stays hidden for this render.
    type QuotedCandidate = Candidate & { quote: LiveQuote };
    const candidates: QuotedCandidate[] = peerTickers
      .map((t, i): QuotedCandidate | null => {
        const d = peerDetails[i];
        const q = marketMap[t];
        if (!q) return null;
        return {
          ticker: t,
          name: d?.name ?? t,
          pct: q.percentChange,
          ret1y: returnOf(t),
          volume: q.volume,
          marketCap: d?.marketCap ?? null,
          sicCode: d?.sicCode ?? null,
          sector: d?.sector ?? null,
          quote: q,
        };
      })
      .filter((c): c is QuotedCandidate => c !== null);

    if (candidates.length === 0) return [];

    const curPct = marketMap[symbol]?.percentChange ?? null;
    const curRet = returnOf(symbol);
    const curVol = marketMap[symbol]?.volume ?? null;
    const curCap = currentDetail?.marketCap ?? null;
    const curSic = currentDetail?.sicCode ?? null;
    const curSector = currentDetail?.sector ?? null;

    // Comparison anchors for the "Key Reason" engine. Peer selection (below)
    // still uses the raw fields; these feed the human-readable insight only.
    const subjectStats: RelationStats = {
      ticker: symbol,
      price: marketMap[symbol]?.price ?? null,
      pct: curPct,
      ret1y: curRet,
      volume: curVol,
      marketCap: curCap,
      sector: curSector,
    };
    const peerStats = (c: QuotedCandidate): RelationStats => ({
      ticker: c.ticker,
      price: c.quote.price,
      pct: c.pct,
      ret1y: c.ret1y,
      volume: c.volume,
      marketCap: c.marketCap,
      sector: c.sector,
    });
    // Shared across all three cards so no two reasons lean on the same angle.
    const usedKinds = new Set<string>();

    const used = new Set<string>();
    const remaining = () => candidates.filter((c) => !used.has(c.ticker));
    const byCategory: Record<string, RelatedCard> = {};
    const major = (s: string | null) => (s ? s.slice(0, 2) : "");
    const normSector = (s: string | null) => (s ? s.trim().toLowerCase() : "");

    const assignIndustry = (allowFuzzy: boolean) => {
      if (byCategory.industry) return;
      const rem = remaining();
      // SIC code is the sharpest match (Polygon). Finnhub has no SIC, so fall
      // back to an exact sector-string match before the fuzzy pass.
      const pick =
        (curSic && rem.find((c) => c.sicCode === curSic)) ||
        (curSic && rem.find((c) => major(c.sicCode) === major(curSic))) ||
        (curSector &&
          rem.find((c) => normSector(c.sector) === normSector(curSector))) ||
        (allowFuzzy ? rem.find((c) => c.sector) || rem[0] : undefined);
      if (!pick) return;
      used.add(pick.ticker);
      byCategory.industry = {
        title: "Similar Industry",
        data: relatedData(
          pick,
          buildRelationInsight(subjectStats, peerStats(pick), "industry", usedKinds)
        ),
      };
    };

    assignIndustry(false);

    {
      const rem = remaining();
      let pick: QuotedCandidate | undefined;
      const withRet = rem.filter((c) => c.ret1y != null);
      if (curRet != null && withRet.length > 0) {
        pick = withRet.reduce((best, c) =>
          Math.abs(c.ret1y! - curRet) < Math.abs(best.ret1y! - curRet)
            ? c
            : best
        );
      } else {
        const withPct = rem.filter((c) => c.pct != null);
        if (curPct != null && withPct.length > 0) {
          pick = withPct.reduce((best, c) =>
            Math.abs(c.pct! - curPct) < Math.abs(best.pct! - curPct) ? c : best
          );
        } else {
          pick = rem[0];
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.return = {
          title: "Similar Return",
          data: relatedData(
            pick,
            buildRelationInsight(subjectStats, peerStats(pick), "return", usedKinds)
          ),
        };
      }
    }

    {
      const rem = remaining();
      const withCap = rem.filter((c) => c.marketCap != null);
      let pick: QuotedCandidate | undefined;
      if (curCap != null && withCap.length > 0) {
        pick = withCap.reduce((best, c) =>
          Math.abs(Math.log(c.marketCap!) - Math.log(curCap)) <
          Math.abs(Math.log(best.marketCap!) - Math.log(curCap))
            ? c
            : best
        );
      } else {
        const withVol = rem.filter((c) => c.volume != null);
        if (curVol != null && withVol.length > 0) {
          pick = withVol.reduce((best, c) =>
            Math.abs(c.volume! - curVol) < Math.abs(best.volume! - curVol)
              ? c
              : best
          );
        } else {
          pick = rem[0];
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.size = {
          title: "Similar Market Cap",
          data: relatedData(
            pick,
            buildRelationInsight(subjectStats, peerStats(pick), "size", usedKinds)
          ),
        };
      }
    }

    assignIndustry(true);

    return [byCategory.return, byCategory.industry, byCategory.size].filter(
      (c): c is RelatedCard => Boolean(c)
    );
  } catch (error) {
    console.error("Related stocks fetch failed:", error);
    return [];
  }
}

export async function getHomeData(defaultTicker: string): Promise<{
  movers: Movers;
  quote: Quote;
  headline: Headline;
}> {
  const [movers, quote, headline] = await Promise.all([
    getMoversData(),
    getQuoteData(defaultTicker),
    getHeadlineData(defaultTicker),
  ]);
  return { movers, quote, headline };
}

export async function getHomeTickerData(ticker: string): Promise<{
  quote: Quote;
  headline: Headline;
}> {
  const [quote, headline] = await Promise.all([
    getQuoteData(ticker),
    getHeadlineData(ticker),
  ]);
  return { quote, headline };
}


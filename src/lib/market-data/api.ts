import "server-only";

import { getCuratedPeers } from "@/data/fallbacks";
import { hasAstra, hasPolygon } from "@/lib/config";
import { formatVolume } from "@/lib/movers";
import type {
  Quote,
  Headline,
  Movers,
  LiveQuote,
  ChatQuote,
  RelatedCard,
  TickerDetail,
  Candidate,
} from "../market-data-types";
import {
  sanitizeTicker,
  mockQuote,
  newsToHeadline,
  pickTopArticle,
  mockHeadline,
  mockMovers,
  summarizeMovers,
  titleCase,
  formatMarketCap,
  fmtPct,
  relatedData,
} from "./transforms";
import {
  getGroupedDailyCached,
  getMarketMapCached,
  getMarketMapYearAgoCached,
  getCandlesCached,
  getNewsCached,
  getPolygonNewsCached,
  getTickerDetailCached,
  getRelatedTickersCached,
} from "./cache";
import {
  getStockCandles,
  getIntraday,
  getWeek,
  getFine,
} from "./queries";

export async function getMoversData(): Promise<Movers> {
  if (hasPolygon) {
    try {
      const live = await getGroupedDailyCached();
      if (live && live.length > 0) return summarizeMovers(live);
    } catch (error) {
      console.error("Polygon movers fetch failed, using fallback:", error);
    }
  }
  return summarizeMovers(mockMovers());
}

export async function getQuoteData(ticker: string): Promise<Quote> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockQuote("N/A");

  const [stock_data, intraday, week, fine] = await Promise.all([
    getStockCandles(symbol),
    getIntraday(symbol),
    getWeek(symbol),
    getFine(symbol),
  ]);

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
      const news = await getPolygonNewsCached(symbol);
      if (news.length > 0) return newsToHeadline(symbol, news[0]);
    } catch (error) {
      console.error("Polygon headline fetch failed, using fallback:", error);
    }
  }
  return mockHeadline(symbol);
}

export async function getLiveQuotes(tickers: string[]): Promise<LiveQuote[]> {
  if (!hasPolygon || tickers.length === 0) return [];
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

// Per-ticker daily aggregates (shared cache with detail page) — unlike getLiveQuotes,
// these resolve before the market-wide grouped snapshot closes.
export async function getChatQuotes(tickers: string[]): Promise<ChatQuote[]> {
  if (!hasPolygon || tickers.length === 0) return [];
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

export async function getRelatedStocksData(
  ticker: string
): Promise<RelatedCard[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol || !hasPolygon) return [];

  try {
    const relatedTickers = await getRelatedTickersCached(symbol);
    let peerTickers = Array.from(new Set(relatedTickers.map(sanitizeTicker)))
      .filter((t) => t && t !== symbol)
      .slice(0, 8);

    if (peerTickers.length === 0) {
      peerTickers = Array.from(new Set(getCuratedPeers(symbol).map(sanitizeTicker)))
        .filter((t) => t && t !== symbol)
        .slice(0, 8);
    }

    if (peerTickers.length === 0) return [];

    const [marketMap, yearAgoMap, currentDetail, peerDetails] =
      await Promise.all([
        getMarketMapCached().catch(() => ({}) as Record<string, LiveQuote>),
        getMarketMapYearAgoCached().catch(() => ({}) as Record<string, number>),
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

    const candidates: Candidate[] = peerTickers.map((t, i) => {
      const d = peerDetails[i];
      const q = marketMap[t];
      return {
        ticker: t,
        name: d?.name ?? t,
        pct: q ? q.percentChange : null,
        ret1y: returnOf(t),
        volume: q ? q.volume : null,
        marketCap: d?.marketCap ?? null,
        sicCode: d?.sicCode ?? null,
        sector: d?.sector ?? null,
        quote: q,
      };
    });

    const curPct = marketMap[symbol]?.percentChange ?? null;
    const curRet = returnOf(symbol);
    const curVol = marketMap[symbol]?.volume ?? null;
    const curCap = currentDetail?.marketCap ?? null;
    const curSic = currentDetail?.sicCode ?? null;

    const used = new Set<string>();
    const remaining = () => candidates.filter((c) => !used.has(c.ticker));
    const byCategory: Record<string, RelatedCard> = {};
    const major = (s: string | null) => (s ? s.slice(0, 2) : "");

    const assignIndustry = (allowFuzzy: boolean) => {
      if (byCategory.industry) return;
      const rem = remaining();
      const pick =
        (curSic && rem.find((c) => c.sicCode === curSic)) ||
        (curSic && rem.find((c) => major(c.sicCode) === major(curSic))) ||
        (allowFuzzy ? rem.find((c) => c.sector) || rem[0] : undefined);
      if (!pick) return;
      used.add(pick.ticker);
      const reason = pick.sector
        ? `${titleCase(pick.sector)} sector`
        : `Peer of ${symbol}`;
      byCategory.industry = {
        title: "Similar Industry",
        data: relatedData(pick, reason),
      };
    };

    assignIndustry(false);

    {
      const rem = remaining();
      let pick: Candidate | undefined;
      let reason = "";
      const withRet = rem.filter((c) => c.ret1y != null);
      if (curRet != null && withRet.length > 0) {
        pick = withRet.reduce((best, c) =>
          Math.abs(c.ret1y! - curRet) < Math.abs(best.ret1y! - curRet)
            ? c
            : best
        );
        reason = `1Y return ${fmtPct(pick.ret1y!)} (${symbol} ${fmtPct(
          curRet
        )})`;
      } else {
        const withPct = rem.filter((c) => c.pct != null);
        if (curPct != null && withPct.length > 0) {
          pick = withPct.reduce((best, c) =>
            Math.abs(c.pct! - curPct) < Math.abs(best.pct! - curPct) ? c : best
          );
          reason = `Daily move ${fmtPct(pick.pct!)} (${symbol} ${fmtPct(
            curPct
          )})`;
        } else {
          pick = rem[0];
          reason = pick ? `Moves with ${symbol}` : "";
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.return = {
          title: "Similar Return",
          data: relatedData(pick, reason),
        };
      }
    }

    {
      const rem = remaining();
      const withCap = rem.filter((c) => c.marketCap != null);
      let pick: Candidate | undefined;
      let reason = "";
      if (curCap != null && withCap.length > 0) {
        pick = withCap.reduce((best, c) =>
          Math.abs(Math.log(c.marketCap!) - Math.log(curCap)) <
          Math.abs(Math.log(best.marketCap!) - Math.log(curCap))
            ? c
            : best
        );
        reason = `${formatMarketCap(pick.marketCap)} market cap`;
      } else {
        const withVol = rem.filter((c) => c.volume != null);
        if (curVol != null && withVol.length > 0) {
          pick = withVol.reduce((best, c) =>
            Math.abs(c.volume! - curVol) < Math.abs(best.volume! - curVol)
              ? c
              : best
          );
          reason = `${formatVolume(pick.volume!)} daily volume`;
        } else {
          pick = rem[0];
          reason = pick ? `Related to ${symbol}` : "";
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.size = {
          title: "Similar Market Cap",
          data: relatedData(pick, reason),
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


import "server-only";

import { generateMockWeek } from "@/data/fallbacks";
import { hasAstra, hasAlpaca, hasPolygon } from "@/lib/config";
import type { Headline, Movers, Quote } from "./types";
import {
  mockHeadline,
  mockMovers,
  mockQuote,
  newsToHeadline,
  pickTopArticle,
  sanitizeTicker,
  summarizeMovers,
} from "./transforms";
import {
  getGroupedDailyCached,
  getMarketMapCached,
  getHeadlineArticlesCached,
} from "./cache";
import {
  getFine,
  getIntraday,
  getStockCandles,
  weekFromFine,
} from "./queries";

const hasPrices = hasAlpaca || hasPolygon;

export async function getMoversData(): Promise<Movers> {
  if (hasPrices) {
    try {
      const live = await getGroupedDailyCached();
      if (live && live.length > 0) return summarizeMovers(live, "live");
    } catch (error) {
      console.error("Movers fetch failed, using fallback:", error);
    }
  }
  return summarizeMovers(mockMovers(), "sample");
}

export async function getQuoteData(ticker: string): Promise<Quote> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return mockQuote("N/A");

  const [stock_data, intraday, fine] = await Promise.all([
    getStockCandles(symbol),
    getIntraday(symbol),
    getFine(symbol),
  ]);
  const week = hasPrices ? weekFromFine(fine) : generateMockWeek(symbol);

  if (!stock_data) {
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
      const news = await getHeadlineArticlesCached(symbol);
      if (news.length > 0)
        return newsToHeadline(symbol, pickTopArticle(news), "live");
    } catch (error) {
      console.error("Astra headline fetch failed, using fallback:", error);
    }
  }
  return mockHeadline(symbol);
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

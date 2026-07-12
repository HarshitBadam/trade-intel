import "server-only";

import { hasAlpaca, hasFinnhub, hasPolygon } from "@/lib/config";
import type {
  ChatFundamentals,
  ChatQuote,
  LiveQuote,
} from "./types";
import {
  getCandlesFresh,
  getMarketMapCached,
} from "./cache";
import { finnhubBasicFinancials, finnhubEarnings } from "./finnhub";

const hasPrices = hasAlpaca || hasPolygon;

type FreshCandles = Awaited<ReturnType<typeof getCandlesFresh>>;
const CHAT_CANDLE_TTL_MS = 2 * 60 * 1000;
const chatCandleCache = new Map<
  string,
  { expiresAt: number; value: Promise<FreshCandles> }
>();
const CHAT_FUNDAMENTALS_TTL_MS = 30 * 60 * 1000;
const chatFundamentalsCache = new Map<
  string,
  { expiresAt: number; value: Promise<ChatFundamentals | null> }
>();

async function getChatCandles(ticker: string): Promise<FreshCandles> {
  const cached = chatCandleCache.get(ticker);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = getCandlesFresh(ticker);
  chatCandleCache.set(ticker, {
    expiresAt: Date.now() + CHAT_CANDLE_TTL_MS,
    value,
  });
  if (chatCandleCache.size > 100) {
    chatCandleCache.delete(chatCandleCache.keys().next().value as string);
  }
  try {
    return await value;
  } catch (error) {
    chatCandleCache.delete(ticker);
    throw error;
  }
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
  const uniq = [...new Set(tickers.map((t) => t.toUpperCase()))].slice(0, 4);

  const results = await Promise.allSettled(
    uniq.map(async (ticker): Promise<ChatQuote | null> => {
      const c = await getChatCandles(ticker);
      if (!c || c.chart_data.length < 2) return null;
      const closes = c.chart_data.map((d) => d.value);
      const i = closes.length - 1;
      const pctBack = (sessions: number): number | null => {
        const j = i - sessions;
        return j >= 0 && closes[j] > 0
          ? ((closes[i] - closes[j]) / closes[j]) * 100
          : null;
      };
      const dateBack = (sessions: number): string | undefined => {
        const j = i - sessions;
        return j >= 0 ? c.chart_data[j].date : undefined;
      };
      return {
        ticker,
        price: c.stock_price,
        asOf: c.chart_data[i].date,
        dayPct: c.percent_change,
        fewDaysPct: pctBack(3),
        weekPct: pctBack(5),
        monthPct: pctBack(21),
        yearPct: pctBack(252),
        fewDaysStart: dateBack(3),
        weekStart: dateBack(5),
        monthStart: dateBack(21),
        yearStart: dateBack(252),
      };
    })
  );

  if (results.every((result) => result.status === "rejected")) {
    throw new Error("All configured quote providers failed");
  }
  return results
    .filter(
      (result): result is PromiseFulfilledResult<ChatQuote | null> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter((quote): quote is ChatQuote => Boolean(quote));
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function getOneChatFundamentals(
  ticker: string
): Promise<ChatFundamentals | null> {
  const cached = chatFundamentalsCache.get(ticker);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = (async () => {
    const [metricsResult, earningsResult] = await Promise.allSettled([
      finnhubBasicFinancials(ticker),
      finnhubEarnings(ticker),
    ]);
    const metrics =
      metricsResult.status === "fulfilled"
        ? metricsResult.value?.metric
        : undefined;
    const earning =
      earningsResult.status === "fulfilled" ? earningsResult.value[0] : undefined;
    if (!metrics && !earning) return null;
    return {
      ticker,
      asOf: new Date().toISOString(),
      peTtm: finiteMetric(
        metrics?.peBasicExclExtraTTM ?? metrics?.peTTM ?? metrics?.peNormalizedAnnual
      ),
      revenueGrowthTtmYoy: finiteMetric(metrics?.revenueGrowthTTMYoy),
      beta: finiteMetric(metrics?.beta),
      earnings: earning
        ? {
            period: earning.period ?? "latest reported quarter",
            quarter: finiteMetric(earning.quarter),
            year: finiteMetric(earning.year),
            actualEps: finiteMetric(earning.actual),
            estimatedEps: finiteMetric(earning.estimate),
            surprisePercent: finiteMetric(earning.surprisePercent),
          }
        : null,
    } satisfies ChatFundamentals;
  })();

  chatFundamentalsCache.set(ticker, {
    expiresAt: Date.now() + CHAT_FUNDAMENTALS_TTL_MS,
    value,
  });
  if (chatFundamentalsCache.size > 100) {
    chatFundamentalsCache.delete(
      chatFundamentalsCache.keys().next().value as string
    );
  }
  try {
    return await value;
  } catch (error) {
    chatFundamentalsCache.delete(ticker);
    throw error;
  }
}

export async function getChatFundamentals(
  tickers: string[]
): Promise<ChatFundamentals[]> {
  if (!hasFinnhub || tickers.length === 0) return [];
  const unique = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))].slice(
    0,
    8
  );
  const results = await Promise.allSettled(
    unique.map((ticker) => getOneChatFundamentals(ticker))
  );
  return results
    .filter(
      (
        result
      ): result is PromiseFulfilledResult<ChatFundamentals | null> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter((value): value is ChatFundamentals => Boolean(value));
}

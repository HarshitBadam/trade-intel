import "server-only";

import { buildChatQuote } from "./quote-metrics";
import type { ChatQuote } from "./types";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_TIMEOUT_MS = 1_200;
const YAHOO_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_ASX_QUOTES = 6;
const MAX_CACHE_ENTRIES = 50;

type YahooResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type YahooFetch = (
  url: string,
  init: RequestInit
) => Promise<YahooResponse>;

const quoteCache = new Map<
  string,
  { expiresAt: number; value: Promise<ChatQuote | null> }
>();

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function asxDate(timestampSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampSeconds * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function yahooAsxSymbol(ticker: string): string | null {
  const normalized = ticker.trim().toUpperCase().replace(/\.AX$/, "");
  return /^[A-Z0-9]{2,6}$/.test(normalized) ? `${normalized}.AX` : null;
}

/**
 * Converts Yahoo's chart payload into the same normalized quote shape used by
 * StockSage's other market sources. Invalid identity, currency, or bars fail
 * closed so an unrelated Yahoo instrument can never be presented as ASX data.
 */
export function parseYahooAsxChart(
  ticker: string,
  yahooSymbol: string,
  payload: unknown
): ChatQuote | null {
  const expectedSymbol = yahooAsxSymbol(ticker);
  const normalizedSymbol = yahooSymbol.trim().toUpperCase();
  const root = objectValue(payload);
  const chart = objectValue(root?.chart);
  if (!chart || chart.error != null || !Array.isArray(chart.result)) return null;
  const result = objectValue(chart.result[0]);
  const meta = objectValue(result?.meta);
  const exchange = String(
    meta?.exchangeName ?? meta?.fullExchangeName ?? ""
  ).toUpperCase();
  if (
    !expectedSymbol ||
    expectedSymbol !== normalizedSymbol ||
    !result ||
    !meta ||
    String(meta.symbol ?? "").toUpperCase() !== expectedSymbol ||
    String(meta.currency ?? "").toUpperCase() !== "AUD" ||
    exchange !== "ASX" ||
    String(meta.instrumentType ?? "").toUpperCase() !== "EQUITY"
  ) {
    return null;
  }

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const indicators = objectValue(result.indicators);
  const quoteSeries = Array.isArray(indicators?.quote)
    ? objectValue(indicators.quote[0])
    : null;
  const adjustedSeries = Array.isArray(indicators?.adjclose)
    ? objectValue(indicators.adjclose[0])
    : null;
  const adjustedCloses = Array.isArray(adjustedSeries?.adjclose)
    ? adjustedSeries.adjclose
    : [];
  const rawCloses = Array.isArray(quoteSeries?.close)
    ? quoteSeries.close
    : [];
  // Never mix adjusted and unadjusted historical points. Around a split or
  // dividend, substituting one raw close into an adjusted series can turn a
  // missing bar into a fabricated return. A sparse adjusted series fails
  // closed; raw closes are used only when adjusted history is unavailable.
  const useAdjustedCloses =
    adjustedCloses.filter((value) => positiveNumber(value) !== null).length >= 2;
  const byDate = new Map<string, number>();
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = positiveNumber(timestamps[index]);
    const close = positiveNumber(
      useAdjustedCloses ? adjustedCloses[index] : rawCloses[index]
    );
    if (!timestamp || !close) continue;
    byDate.set(asxDate(timestamp), close);
  }

  const marketPrice = positiveNumber(meta.regularMarketPrice);
  const marketTime = positiveNumber(meta.regularMarketTime);
  if (marketPrice && marketTime) {
    byDate.set(asxDate(marketTime), marketPrice);
  }
  const points = [...byDate]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const latest = points.at(-1);
  const previous = points.at(-2);
  if (!latest || !previous) return null;

  const previousClose =
    positiveNumber(meta.regularMarketPreviousClose) ?? previous.value;
  const dayPct =
    previousClose > 0
      ? ((latest.value - previousClose) / previousClose) * 100
      : 0;
  const quote = buildChatQuote(points, {
    ticker: expectedSymbol.slice(0, -3),
    price: latest.value,
    dayPct,
    sourceNote: "Yahoo Finance delayed ASX data",
  });
  return quote
    ? {
        ...quote,
        instrumentSymbol: expectedSymbol,
        venue: "ASX",
        currency: "AUD",
      }
    : null;
}

async function fetchYahooChart(
  yahooSymbol: string,
  fetcher: YahooFetch
): Promise<unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startSeconds = nowSeconds - 420 * 24 * 60 * 60;
  const url = new URL(`${YAHOO_CHART_URL}${encodeURIComponent(yahooSymbol)}`);
  url.searchParams.set("period1", String(startSeconds));
  url.searchParams.set("period2", String(nowSeconds + 24 * 60 * 60));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "div,splits");
  url.searchParams.set("includeAdjustedClose", "true");
  const response = await fetcher(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 StockSage/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance responded with ${response.status}`);
  }
  return response.json();
}

async function loadYahooAsxQuote(
  ticker: string,
  yahooSymbol: string,
  fetcher: YahooFetch
): Promise<ChatQuote | null> {
  const payload = await fetchYahooChart(yahooSymbol, fetcher);
  const quote = parseYahooAsxChart(ticker, yahooSymbol, payload);
  if (!quote) throw new Error(`Yahoo Finance returned no usable ${yahooSymbol} series`);
  return quote;
}

/**
 * Keyless server-side ASX quotes. Provider failures are deliberately converted
 * to partial/empty results so they cannot escape into the answer path.
 */
export async function getYahooAsxQuotes(
  tickers: string[],
  fetcher: YahooFetch = fetch
): Promise<ChatQuote[]> {
  const requests = [
    ...new Set(
      tickers.flatMap((ticker) => {
        const symbol = yahooAsxSymbol(ticker);
        return symbol ? [symbol] : [];
      })
    ),
  ]
    .map((symbol) => ({ ticker: symbol.slice(0, -3), symbol }))
    .slice(0, MAX_ASX_QUOTES);
  if (requests.length === 0) return [];

  const results = await Promise.allSettled(
    requests.map(async ({ ticker, symbol }) => {
      const cached = quoteCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = loadYahooAsxQuote(ticker, symbol, fetcher);
      quoteCache.set(symbol, {
        expiresAt: Date.now() + YAHOO_CACHE_TTL_MS,
        value,
      });
      if (quoteCache.size > MAX_CACHE_ENTRIES) {
        quoteCache.delete(quoteCache.keys().next().value as string);
      }
      try {
        return await value;
      } catch {
        quoteCache.delete(symbol);
        return null;
      }
    })
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
}

export function resetYahooAsxCache(): void {
  quoteCache.clear();
}

import "server-only";

import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import type { ChatQuote } from "./types";
import { buildChatQuote } from "./quote-metrics";

// Keyless EOD coverage for indices and Australian listings via US ADRs.
const STOOQ_HISTORY_URL = "https://stooq.com/q/d/l/";
// Last fallback; reject anti-bot HTML before it consumes the retrieval budget.
const STOOQ_TIMEOUT_MS = 4_000;
const STOOQ_CACHE_TTL_MS = 10 * 60 * 1000;

type DailyBar = { date: string; close: number };

const quoteCache = new Map<
  string,
  { expiresAt: number; value: Promise<ChatQuote | null> }
>();

// Stooq CSV is oldest-first with ISO dates; malformed rows are skipped.
export function parseStooqDailyCsv(csv: string): DailyBar[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open,high,low,close/i.test(lines[0])) {
    return [];
  }
  const bars: DailyBar[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const date = cells[0]?.trim();
    const close = Number.parseFloat(cells[4] ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    bars.push({ date: date as string, close });
  }
  return bars;
}

// Uses trailing-session windows and calendar baselines for YTD/MTD.
export function chatQuoteFromDailyBars(
  ticker: string,
  bars: DailyBar[]
): ChatQuote | null {
  const points = bars.map(({ date, close }) => ({ date, value: close }));
  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  const dayPct =
    latest && previous && previous.value > 0
      ? ((latest.value - previous.value) / previous.value) * 100
      : 0;
  return buildChatQuote(points, {
    ticker,
    price: latest?.value ?? 0,
    dayPct,
    eod: true,
  });
}

export type StooqFetcher = (symbol: string) => Promise<string>;

function historyRange(): { d1: string; d2: string } {
  const format = (date: Date) =>
    date.toISOString().slice(0, 10).replace(/-/g, "");
  const now = new Date();
  const start = new Date(now.getTime() - 420 * 24 * 60 * 60 * 1000);
  return { d1: format(start), d2: format(now) };
}

async function fetchStooqCsv(symbol: string): Promise<string> {
  const { d1, d2 } = historyRange();
  const url = `${STOOQ_HISTORY_URL}?s=${encodeURIComponent(symbol)}&i=d&d1=${d1}&d2=${d2}`;
  const response = await fetch(url, {
    headers: {
      // A browser-like user agent avoids Stooq's bot interstitial.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/csv,text/plain,*/*",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(STOOQ_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Stooq responded with ${response.status}`);
  }
  const text = await response.text();
  if (
    !/^Date,Open,High,Low,Close(?:,Volume)?/i.test(text.trimStart()) ||
    /<(?:html|script|form)\b/i.test(text)
  ) {
    throw new Error("Stooq returned non-CSV content");
  }
  return text;
}

async function loadStooqQuote(
  ticker: string,
  symbol: string,
  fetcher: StooqFetcher
): Promise<ChatQuote | null> {
  const csv = await fetcher(symbol);
  const bars = parseStooqDailyCsv(csv);
  const quote = chatQuoteFromDailyBars(ticker, bars);
  if (!quote) {
    throw new Error(`Stooq returned no usable series for ${symbol}`);
  }
  return quote;
}

// Fetches cached EOD quotes; partial success does not trip the breaker.
export async function getStooqQuotes(
  pairs: { ticker: string; symbol: string }[],
  fetcher: StooqFetcher = fetchStooqCsv
): Promise<ChatQuote[]> {
  if (pairs.length === 0 || (await isOpen("stooq"))) return [];
  const results = await Promise.allSettled(
    pairs.slice(0, 6).map(async ({ ticker, symbol }) => {
      const key = `${ticker}:${symbol}`;
      const cached = quoteCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = loadStooqQuote(ticker, symbol, fetcher);
      quoteCache.set(key, {
        expiresAt: Date.now() + STOOQ_CACHE_TTL_MS,
        value,
      });
      if (quoteCache.size > 50) {
        quoteCache.delete(quoteCache.keys().next().value as string);
      }
      try {
        return await value;
      } catch (error) {
        quoteCache.delete(key);
        throw error;
      }
    })
  );
  const quotes = results
    .filter(
      (result): result is PromiseFulfilledResult<ChatQuote | null> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter((quote): quote is ChatQuote => Boolean(quote));
  if (quotes.length === 0 && results.length > 0) {
    await recordFailure("stooq");
    const firstError = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )?.reason;
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "retrieval_failure",
        provider: "stooq",
        reason:
          firstError instanceof Error ? firstError.message.slice(0, 120) : "unknown",
      })}`
    );
    return [];
  }
  await recordSuccess("stooq");
  return quotes;
}

export function resetStooqCache(): void {
  quoteCache.clear();
}

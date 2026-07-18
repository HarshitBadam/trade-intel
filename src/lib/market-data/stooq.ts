import "server-only";

import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import type { ChatQuote } from "./types";

// Stooq serves keyless end-of-day CSVs — free coverage for market indices
// and Australian listings (via their US ADR series) that the primary US
// intraday providers don't carry. Data is EOD/delayed; ChatQuote.eod flags
// that so answers can label the as-of date honestly.
const STOOQ_HISTORY_URL = "https://stooq.com/q/d/l/";
// Stooq is a last fallback behind the authenticated proxy feed. Fail fast on
// its anti-bot interstitial so one HTML response cannot consume the whole
// retrieval budget.
const STOOQ_TIMEOUT_MS = 4_000;
const STOOQ_CACHE_TTL_MS = 10 * 60 * 1000;

type DailyBar = { date: string; close: number };

const quoteCache = new Map<
  string,
  { expiresAt: number; value: Promise<ChatQuote | null> }
>();

// Stooq daily history CSV: "Date,Open,High,Low,Close,Volume" with ISO dates,
// oldest first. Malformed rows are skipped rather than failing the series.
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

// Same window math as the primary chat-quote path (api-chat.ts): trailing
// sessions for day/week/month/year, calendar baselines for YTD and MTD.
export function chatQuoteFromDailyBars(
  ticker: string,
  bars: DailyBar[]
): ChatQuote | null {
  if (bars.length < 2) return null;
  const closes = bars.map((bar) => bar.close);
  const i = closes.length - 1;
  const pctBack = (sessions: number): number | null => {
    const j = i - sessions;
    return j >= 0 && closes[j] > 0
      ? ((closes[i] - closes[j]) / closes[j]) * 100
      : null;
  };
  const dateBack = (sessions: number): string | undefined => {
    const j = i - sessions;
    return j >= 0 ? bars[j].date : undefined;
  };
  const prevSessionPct =
    i >= 2 && closes[i - 2] > 0
      ? ((closes[i - 1] - closes[i - 2]) / closes[i - 2]) * 100
      : null;
  const prevSessionDate = i >= 1 ? bars[i - 1].date : undefined;
  const currentYear = bars[i].date.slice(0, 4);
  const firstOfYear = bars.findIndex((bar) => bar.date.startsWith(currentYear));
  const ytdBase = firstOfYear > 0 ? firstOfYear - 1 : firstOfYear;
  const ytdPct =
    ytdBase >= 0 && ytdBase < i && closes[ytdBase] > 0
      ? ((closes[i] - closes[ytdBase]) / closes[ytdBase]) * 100
      : null;
  const ytdStart = ytdBase >= 0 && ytdBase < i ? bars[ytdBase].date : undefined;
  const currentMonth = bars[i].date.slice(0, 7);
  const firstOfMonth = bars.findIndex((bar) =>
    bar.date.startsWith(currentMonth)
  );
  const mtdBase = firstOfMonth > 0 ? firstOfMonth - 1 : firstOfMonth;
  const mtdPct =
    mtdBase >= 0 && mtdBase < i && closes[mtdBase] > 0
      ? ((closes[i] - closes[mtdBase]) / closes[mtdBase]) * 100
      : null;
  const mtdStart = mtdBase >= 0 && mtdBase < i ? bars[mtdBase].date : undefined;
  return {
    ticker,
    price: closes[i],
    asOf: bars[i].date,
    eod: true,
    dayPct: pctBack(1) ?? 0,
    prevSessionPct,
    prevSessionDate,
    fewDaysPct: pctBack(3),
    weekPct: pctBack(5),
    monthPct: pctBack(21),
    yearPct: pctBack(252),
    ytdPct,
    ytdStart,
    mtdPct,
    mtdStart,
    fewDaysStart: dateBack(3),
    weekStart: dateBack(5),
    monthStart: dateBack(21),
    yearStart: dateBack(252),
  };
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
      // Stooq serves the CSV to ordinary browsers; a bare fetch UA is more
      // likely to hit its bot interstitial.
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

// Fetches EOD ChatQuotes for (app ticker, stooq symbol) pairs, with a short
// cache and the shared circuit breaker. Partial success is success; the
// breaker only counts turns where every symbol failed.
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

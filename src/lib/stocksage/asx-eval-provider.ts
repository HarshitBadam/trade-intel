import "server-only";

import {
  asxEvalProvider,
  EODHD_API_KEY,
  MARKETSTACK_API_KEY,
} from "@/lib/config";

/**
 * Evaluation-only native ASX quotes.
 *
 * Nothing in the request path may import this module. It exists so the parity
 * benchmark can measure what a licensed ASX feed would deliver against the
 * current Stooq/ADR-proxy path, which is the go/no-go input for declaring
 * AU/US numeric parity.
 */
export type AsxEvalQuote = {
  ticker: string;
  /** Exchange-local close in AUD. */
  close: number;
  /** Session-over-session percentage change, exchange-local. */
  changePercent?: number;
  /** Exchange-local session date, YYYY-MM-DD. */
  session: string;
  provider: "eodhd" | "marketstack";
  latencyMs: number;
};

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fromEodhd(
  ticker: string,
  timeoutMs: number
): Promise<AsxEvalQuote | null> {
  const startedAt = Date.now();
  const payload = (await fetchJson(
    `https://eodhd.com/api/real-time/${ticker}.AU?api_token=${EODHD_API_KEY}&fmt=json`,
    timeoutMs
  )) as {
    close?: number | string;
    change_p?: number | string;
    timestamp?: number;
  };
  const close = Number(payload.close);
  if (!Number.isFinite(close)) return null;
  const changePercent = Number(payload.change_p);
  return {
    ticker,
    close,
    ...(Number.isFinite(changePercent) ? { changePercent } : {}),
    session: new Date((payload.timestamp ?? Date.now() / 1000) * 1000)
      .toISOString()
      .slice(0, 10),
    provider: "eodhd",
    latencyMs: Date.now() - startedAt,
  };
}

async function fromMarketstack(
  ticker: string,
  timeoutMs: number
): Promise<AsxEvalQuote | null> {
  const startedAt = Date.now();
  const payload = (await fetchJson(
    `https://api.marketstack.com/v1/eod/latest?access_key=${MARKETSTACK_API_KEY}&symbols=${ticker}.XASX`,
    timeoutMs
  )) as { data?: { close?: number; open?: number; date?: string }[] };
  const row = payload.data?.[0];
  if (!row || !Number.isFinite(row.close)) return null;
  const close = row.close as number;
  const open = row.open;
  return {
    ticker,
    close,
    ...(open && Number.isFinite(open)
      ? { changePercent: ((close - open) / open) * 100 }
      : {}),
    session: (row.date ?? new Date().toISOString()).slice(0, 10),
    provider: "marketstack",
    latencyMs: Date.now() - startedAt,
  };
}

export async function fetchAsxEvalQuotes(
  tickers: string[],
  timeoutMs = 4_000
): Promise<AsxEvalQuote[]> {
  if (asxEvalProvider === "none") return [];
  const fetcher = asxEvalProvider === "eodhd" ? fromEodhd : fromMarketstack;
  const settled = await Promise.all(
    tickers.map((ticker) =>
      fetcher(ticker, timeoutMs).catch(() => null)
    )
  );
  return settled.filter((quote): quote is AsxEvalQuote => quote !== null);
}

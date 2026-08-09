import "server-only";

import { isOpen } from "@/lib/breaker";
import {
  getChatQuotes,
  getStooqQuotes,
  getYahooAsxQuotes,
  type ChatQuote,
} from "@/lib/market-data";
import {
  ASX_NATIVE_TICKERS,
  MARKET_PROXY_SYMBOLS,
  STOOQ_SYMBOLS,
} from "../entity-catalog";
import type { EvidenceQuery } from "../types";
import type { TemporalInterval } from "../temporal";

export type MarketQuoteFetcher = (
  symbols: string[],
  intervals?: readonly TemporalInterval[]
) => Promise<ChatQuote[]>;
export type StooqQuoteFetcher = (
  pairs: { ticker: string; symbol: string }[],
  intervals?: readonly TemporalInterval[]
) => Promise<ChatQuote[]>;
export type AsxQuoteFetcher = (
  tickers: string[],
  intervals?: readonly TemporalInterval[]
) => Promise<ChatQuote[]>;

const defaultQuoteFetcher: MarketQuoteFetcher = (symbols, intervals = []) =>
  getChatQuotes(symbols, undefined, intervals);
const defaultStooqFetcher: StooqQuoteFetcher = (pairs, intervals = []) =>
  getStooqQuotes(pairs, undefined, intervals);
const defaultAsxFetcher: AsxQuoteFetcher = (tickers, intervals = []) =>
  getYahooAsxQuotes(tickers, undefined, intervals);

async function fetchProxyCandidates(
  symbols: string[],
  fetcher: MarketQuoteFetcher,
  intervals: readonly TemporalInterval[]
): Promise<ChatQuote[]> {
  const output: ChatQuote[] = [];
  for (let index = 0; index < symbols.length; index += 4) {
    try {
      output.push(
        ...(await fetcher(symbols.slice(index, index + 4), intervals))
      );
    } catch {
      continue;
    }
  }
  return output;
}

export async function retrieveMarketProxy(
  query: EvidenceQuery,
  quoteFetcher: MarketQuoteFetcher = defaultQuoteFetcher,
  stooqFetcher: StooqQuoteFetcher = defaultStooqFetcher,
  asxFetcher: AsxQuoteFetcher = defaultAsxFetcher,
  intervals: readonly TemporalInterval[] = []
): Promise<ChatQuote[]> {
  if (query.provider !== "market_proxy" || query.tickers.length === 0) {
    return [];
  }
  const logicalTickers = [
    ...new Set(
      query.tickers.filter(
        (ticker) =>
          ASX_NATIVE_TICKERS.has(ticker) || Boolean(MARKET_PROXY_SYMBOLS[ticker])
      )
    ),
  ];
  const resolved = new Map<string, ChatQuote>();
  const asxTickers = logicalTickers.filter((ticker) =>
    ASX_NATIVE_TICKERS.has(ticker)
  );
  if (asxTickers.length > 0) {
    let nativeQuotes: ChatQuote[] = [];
    try {
      nativeQuotes = await asxFetcher(asxTickers, intervals);
    } catch {
      nativeQuotes = [];
    }
    for (const quote of nativeQuotes) {
      const ticker = quote.ticker.toUpperCase().replace(/\.AX$/, "");
      const instrumentSymbol = quote.instrumentSymbol?.toUpperCase();
      // The retrieval layer is the final boundary before figures are rendered.
      // Do not manufacture ASX/AUD identity for a malformed provider result.
      if (
        !asxTickers.includes(ticker) ||
        instrumentSymbol !== `${ticker}.AX` ||
        quote.venue !== "ASX" ||
        quote.currency !== "AUD" ||
        quote.proxySymbol !== undefined
      ) {
        continue;
      }
      resolved.set(ticker, {
        ...quote,
        ticker,
        instrumentSymbol,
        proxySymbol: undefined,
        proxyKind: undefined,
      });
    }
  }
  const quotesAvailable = !(await isOpen("quotes"));
  const maxCandidates = Math.max(
    0,
    ...logicalTickers.map(
      (ticker) => MARKET_PROXY_SYMBOLS[ticker]?.candidates.length ?? 0
    )
  );

  if (quotesAvailable) {
    for (
      let candidateIndex = 0;
      candidateIndex < maxCandidates;
      candidateIndex += 1
    ) {
      const candidates = logicalTickers.flatMap((ticker) => {
        if (resolved.has(ticker)) return [];
        const candidate =
          MARKET_PROXY_SYMBOLS[ticker]?.candidates[candidateIndex];
        return candidate ? [{ ticker, ...candidate }] : [];
      });
      const quotes = await fetchProxyCandidates(
        candidates.map((candidate) => candidate.symbol),
        quoteFetcher,
        intervals
      );
      const bySymbol = new Map(
        quotes.map((quote) => [quote.ticker.toUpperCase(), quote])
      );
      for (const candidate of candidates) {
        const quote = bySymbol.get(candidate.symbol);
        if (!quote) continue;
        const listing = MARKET_PROXY_SYMBOLS[candidate.ticker];
        resolved.set(candidate.ticker, {
          ...quote,
          ticker: candidate.ticker,
          proxySymbol: candidate.symbol,
          proxyKind: listing.kind,
          sourceNote: candidate.note,
          isIndex: false,
        });
      }
    }
  }

  const unresolved = logicalTickers.filter((ticker) => !resolved.has(ticker));
  if (unresolved.length > 0) {
    const pairs = unresolved.flatMap((ticker) => {
      const listing = STOOQ_SYMBOLS[ticker];
      return listing ? [{ ticker, symbol: listing.symbol }] : [];
    });
    let stooqQuotes: ChatQuote[] = [];
    try {
      stooqQuotes = await stooqFetcher(pairs, intervals);
    } catch {
      stooqQuotes = [];
    }
    for (const quote of stooqQuotes) {
      const listing = STOOQ_SYMBOLS[quote.ticker];
      resolved.set(quote.ticker, {
        ...quote,
        sourceNote: listing?.note,
        ...(listing?.index ? { isIndex: true } : {}),
      });
    }
  }

  return logicalTickers.flatMap((ticker) => {
    const quote = resolved.get(ticker);
    return quote ? [quote] : [];
  });
}

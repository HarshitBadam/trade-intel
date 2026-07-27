import "server-only";

import { isOpen } from "@/lib/breaker";
import {
  getChatQuotes,
  getStooqQuotes,
  type ChatQuote,
} from "@/lib/market-data";
import { MARKET_PROXY_SYMBOLS, STOOQ_SYMBOLS } from "./entity-catalog";
import type { EvidenceQuery } from "./types";

export type MarketQuoteFetcher = (symbols: string[]) => Promise<ChatQuote[]>;
export type StooqQuoteFetcher = (
  pairs: { ticker: string; symbol: string }[]
) => Promise<ChatQuote[]>;

async function fetchProxyCandidates(
  symbols: string[],
  fetcher: MarketQuoteFetcher
): Promise<ChatQuote[]> {
  const output: ChatQuote[] = [];
  for (let index = 0; index < symbols.length; index += 4) {
    try {
      output.push(...(await fetcher(symbols.slice(index, index + 4))));
    } catch {
      continue;
    }
  }
  return output;
}

export async function retrieveMarketProxy(
  query: EvidenceQuery,
  quoteFetcher: MarketQuoteFetcher = getChatQuotes,
  stooqFetcher: StooqQuoteFetcher = getStooqQuotes
): Promise<ChatQuote[]> {
  if (query.provider !== "market_proxy" || query.tickers.length === 0) {
    return [];
  }
  const logicalTickers = [
    ...new Set(
      query.tickers.filter((ticker) => Boolean(MARKET_PROXY_SYMBOLS[ticker]))
    ),
  ];
  const resolved = new Map<string, ChatQuote>();
  const quotesAvailable = !(await isOpen("quotes"));
  const maxCandidates = Math.max(
    0,
    ...logicalTickers.map(
      (ticker) => MARKET_PROXY_SYMBOLS[ticker].candidates.length
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
          MARKET_PROXY_SYMBOLS[ticker].candidates[candidateIndex];
        return candidate ? [{ ticker, ...candidate }] : [];
      });
      const quotes = await fetchProxyCandidates(
        candidates.map((candidate) => candidate.symbol),
        quoteFetcher
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
      stooqQuotes = await stooqFetcher(pairs);
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

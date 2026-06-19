// Shared market-data DTOs.
//
// These describe the shapes that flow from the server data layer
// (`market-data.ts`, a `server-only` module) out to the `"use server"` action
// wrappers and the client components that render them. They live in their own
// directive-free module on purpose: a `"use server"` file may only export async
// functions, so it cannot re-export types, and client components must not import
// values from a `server-only` module. A neutral types module lets both sides
// share the contract without violating either constraint.

import type { RelatedStock } from "@/data/fallbacks";
import type { News, NewsStatus } from "@/components/RecentInfluential";

export type SearchResult = {
  ticker: string;
  name: string;
};

export type Quote = {
  ticker: string;
  stockPrice: number;
  priceChange: number;
  percentChange: number;
  chartData: { date: string; value: number }[];
  intradayData: { date: string; value: number }[];
  weekData: { date: string; value: number }[];
  fineData: { date: string; value: number }[];
};

export type Headline = {
  ticker: string;
  newsTitle: string;
  newsContent: string;
  source?: string;
  date?: string;
  url?: string;
  sentiment?: string;
};

export type Mover = {
  ticker: string;
  name: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
};

export type Movers = {
  gainers: Mover[];
  losers: Mover[];
  shifts: Mover[];
  mostActive: Mover[];
};

export type LiveQuote = {
  ticker: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
};

// Richer, multi-horizon quote used to ground the StockSage chat. Built from
// per-ticker daily aggregates (the same source the detail page uses), so it is
// reliable for any ticker without depending on the market-wide grouped snapshot.
export type ChatQuote = {
  ticker: string;
  price: number;
  /** latest session change vs the prior close, in percent */
  dayPct: number;
  /** trailing performance, in percent; null when not enough history */
  weekPct: number | null;
  monthPct: number | null;
  yearPct: number | null;
};

export type RelatedCard = { title: string; data: RelatedStock };

export type NewsSummary = {
  mentions: number;
  positiveSentiment: number;
  negativeSentiment: number;
  news: News[];
  status: NewsStatus;
  updatedAt?: string;
};

export type TickerDetail = {
  ticker: string;
  name: string;
  sicCode: string | null;
  sector: string | null;
  marketCap: number | null;
};

export type Candidate = {
  ticker: string;
  name: string;
  pct: number | null;
  ret1y: number | null;
  volume: number | null;
  marketCap: number | null;
  sicCode: string | null;
  sector: string | null;
  quote: LiveQuote | undefined;
};

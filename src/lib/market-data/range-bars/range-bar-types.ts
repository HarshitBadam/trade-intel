import type { getAlpacaBars } from "../providers/alpaca";
import type {
  BarGranularity,
  DataProvenance,
  ExchangeCalendar,
  MarketDataProvider,
  RangeBarRequest,
} from "../provenance";

export type OhlcvBar = {
  timestamp: string;
  /** Exchange-local YYYY-MM-DD session. */
  session: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
  vwap?: number;
};

export type RangeBarStatus = "complete" | "partial" | "unavailable";

export type RangeBarReason =
  | "missing_sessions"
  | "missing_bars"
  | "provider_limit"
  | "provider_error"
  | "listing_not_found"
  | "range_before_listing"
  | "adjustment_unavailable"
  | "unsupported_granularity"
  | "no_data";

export type IntradaySessionCoverage = {
  session: string;
  expectedBars: number;
  coveredBars: number;
  missingBars: number;
  complete: boolean;
};

export type RangeBarSeries = {
  ticker: string;
  instrumentSymbol: string;
  venue: RangeBarRequest["venue"];
  calendar: ExchangeCalendar;
  granularity: BarGranularity;
  adjusted: boolean;
  requestStart: string;
  requestEnd: string;
  bars: OhlcvBar[];
  status: RangeBarStatus;
  reason?: RangeBarReason;
  expectedSessions: string[];
  missingSessions: string[];
  /** Intraday coverage counts regular exchange hours only. */
  expectedBars?: number;
  missingBars?: number;
  sessionCoverage?: IntradaySessionCoverage[];
  provenance?: DataProvenance;
  attemptedProviders: MarketDataProvider[];
  cacheKey: string;
};

export type RangeBarProviderResult = {
  bars: OhlcvBar[];
  provenance?: DataProvenance;
  partial?: boolean;
  reason?: RangeBarReason;
};

export type RangeBarProvider = (
  request: Readonly<RangeBarRequest>
) => Promise<RangeBarProviderResult>;

export interface RangeBarCache {
  get(key: string): Promise<RangeBarSeries | null> | RangeBarSeries | null;
  set(
    key: string,
    value: RangeBarSeries,
    ttlSeconds: number
  ): Promise<void> | void;
}

export type JsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type TextResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type RangeBarProviderName = "alpaca" | "polygon" | "yahoo" | "stooq";

export type RangeBarDependencies = {
  providers?: Partial<Record<RangeBarProviderName, RangeBarProvider>>;
  alpaca?: typeof getAlpacaBars;
  polygonFetch?: (url: string) => Promise<JsonResponse>;
  yahooFetch?: (url: string, init: RequestInit) => Promise<JsonResponse>;
  stooqFetch?: (url: string, init: RequestInit) => Promise<TextResponse>;
  cache?: RangeBarCache;
  now?: () => Date;
  /** Lets fixtures override production provider gates. */
  availability?: Partial<Record<RangeBarProviderName, boolean>>;
};

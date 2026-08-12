import "server-only";

import type { MarketCalendar } from "@/lib/market-calendar";

export type MarketDataProvider =
  | "alpaca"
  | "polygon"
  | "yahoo"
  | "stooq"
  | "sec_edgar"
  | "finnhub"
  | "fixture";

export type MarketVenue = "US" | "ASX" | "INDEX" | "UNKNOWN";
export type MarketCurrency = "USD" | "AUD" | "NONE" | (string & {});
export type ExchangeCalendar = MarketCalendar;
export type BarGranularity = "1Day" | "15Min" | "1Min";
export type AdjustmentKind =
  | "split"
  | "split+dividend"
  | "none"
  | "provider_default";

export type RangeBarRequest = {
  /** Logical entity symbol, which may differ from the fetched instrument. */
  ticker: string;
  /** Exact provider instrument, for example CBA.AX, ^spx, or an ETF proxy. */
  instrumentSymbol?: string;
  venue: MarketVenue;
  calendar: ExchangeCalendar;
  granularity: BarGranularity;
  /** Inclusive exchange-local session dates. */
  startSession: string;
  endSession: string;
  adjusted?: boolean;
};

/**
 * Machine-readable source lineage shared by prices, identities, corporate
 * actions, and SEC records. Request/coverage fields are optional because
 * reference data is point-in-time rather than range-shaped.
 */
export type DataProvenance = {
  provider: MarketDataProvider;
  fetchedAt: string;
  sourceUrl?: string;
  feed?: string;
  adjustment?: AdjustmentKind;
  requestStart?: string;
  requestEnd?: string;
  coverageStart?: string;
  coverageEnd?: string;
  delayed?: boolean;
  proxyFor?: string;
  proxyKind?: "adr" | "etf" | "index";
  notes?: readonly string[];
};

export type ProvenanceInput = Omit<DataProvenance, "fetchedAt"> & {
  fetchedAt?: string | Date;
};

function iso(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export function createProvenance(input: ProvenanceInput): DataProvenance {
  return {
    ...input,
    fetchedAt: iso(input.fetchedAt),
    notes: input.notes ? [...input.notes] : undefined,
  };
}

export function formatProvenance(provenance: DataProvenance): string {
  const provider = provenance.provider
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const details: string[] = [];
  if (provenance.feed) details.push(provenance.feed.toUpperCase());
  if (provenance.adjustment && provenance.adjustment !== "provider_default") {
    details.push(
      provenance.adjustment === "none"
        ? "unadjusted"
        : `${provenance.adjustment}-adjusted`
    );
  }
  if (provenance.delayed) details.push("delayed");
  const coverage =
    provenance.coverageStart && provenance.coverageEnd
      ? `covers ${provenance.coverageStart}–${provenance.coverageEnd}`
      : undefined;
  return [
    provider + (details.length ? ` ${details.join(" ")}` : ""),
    coverage,
    `fetched ${provenance.fetchedAt}`,
    provenance.proxyFor ? `proxy for ${provenance.proxyFor}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

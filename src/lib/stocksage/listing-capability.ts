import { MARKET_PROXY_SYMBOLS } from "./entity-catalog";
import type { MarketCalendar } from "./temporal";
import type { FinanceEntity } from "./types";

export type Venue = "US" | "ASX" | "INDEX" | "PRIVATE" | "UNKNOWN";
export type Currency = "USD" | "AUD" | "NONE";

export type QuoteStrategy =
  | "primary_us"
  | "primary_asx"
  | "adr_proxy"
  | "etf_proxy"
  | "delayed_index"
  | "none";

export type FundamentalsStrategy = "us_provider" | "filings_web" | "none";

/**
 * The instrument that actually supplies a number, kept separate from the
 * company it describes. An ADR return is never an ASX return.
 */
export type InstrumentIdentity = {
  symbol: string;
  venue: Venue;
  currency: Currency;
  kind: "primary" | "adr" | "etf" | "index";
  /** Display identity, e.g. `ASX:MQG` or `MQBKY`. */
  label: string;
  /** How a return sourced from this instrument must be described. */
  returnLabel: string;
  note?: string;
};

export type EvidenceCapabilities = {
  astra: boolean;
  tavily: boolean;
  filings: boolean;
  exchangeAnnouncements: boolean;
};

export type ListingCapability = {
  entityId: string;
  companyName: string;
  primaryVenue: Venue;
  primaryCurrency: Currency;
  marketCalendar: MarketCalendar;
  /** The company's home listing, when it has one. */
  primaryInstrument?: InstrumentIdentity;
  /** The instrument the quote path can actually read today. */
  quoteInstrument?: InstrumentIdentity;
  quoteStrategy: QuoteStrategy;
  fundamentalsStrategy: FundamentalsStrategy;
  evidence: EvidenceCapabilities;
  /**
   * `native` means figures come from the primary listing, `proxy_labeled`
   * means a clearly-identified proxy supplies them, `unavailable` means the
   * answer must not carry price or return claims at all.
   */
  numericParity: "native" | "proxy_labeled" | "unavailable";
};

/**
 * Explicit canonical identity for the Australian companies the product is
 * expected to handle. Ticker alone is ambiguous across venues.
 */
export const AU_PRIMARY_LISTINGS: Record<string, { name: string; symbol: string }> = {
  MQG: { name: "Macquarie Group", symbol: "ASX:MQG" },
  CBA: { name: "Commonwealth Bank", symbol: "ASX:CBA" },
  NAB: { name: "National Australia Bank", symbol: "ASX:NAB" },
  ANZ: { name: "ANZ Group", symbol: "ASX:ANZ" },
  WBC: { name: "Westpac", symbol: "ASX:WBC" },
};

/** `australian-big-four` never includes Macquarie. */
export const AUSTRALIAN_BIG_FOUR = ["CBA", "NAB", "ANZ", "WBC"] as const;

const AU_INDEX_TICKERS = new Set(["AXJO"]);

function proxyInstrument(ticker: string): InstrumentIdentity | undefined {
  const listing = MARKET_PROXY_SYMBOLS[ticker];
  const candidate = listing?.candidates[0];
  if (!listing || !candidate) return undefined;
  const isAdr = listing.kind === "adr";
  return {
    symbol: candidate.symbol,
    venue: "US",
    currency: "USD",
    kind: isAdr ? "adr" : "etf",
    label: candidate.symbol,
    returnLabel: isAdr
      ? `${candidate.symbol} USD ADR return`
      : `${candidate.symbol} ETF return`,
    note: candidate.note,
  };
}

export function listingCapability(entity: FinanceEntity): ListingCapability {
  const ticker = entity.ticker;
  const base = {
    entityId: entity.id,
    companyName: entity.name,
  };

  if (entity.private || (!ticker && entity.market === "web")) {
    return {
      ...base,
      primaryVenue: "PRIVATE",
      primaryCurrency: "NONE",
      marketCalendar: entity.jurisdiction === "Australia" ? "AU" : "US",
      quoteStrategy: "none",
      fundamentalsStrategy: "filings_web",
      evidence: {
        astra: false,
        tavily: true,
        filings: false,
        exchangeAnnouncements: false,
      },
      numericParity: "unavailable",
    };
  }

  if (entity.market === "index" && ticker) {
    const australian = AU_INDEX_TICKERS.has(ticker);
    const proxy = proxyInstrument(ticker);
    const primary: InstrumentIdentity = {
      symbol: ticker,
      venue: "INDEX",
      currency: australian ? "AUD" : "USD",
      kind: "index",
      label: ticker,
      returnLabel: `${entity.name} index return`,
    };
    return {
      ...base,
      primaryVenue: "INDEX",
      primaryCurrency: australian ? "AUD" : "USD",
      marketCalendar: australian ? "AU" : "US",
      primaryInstrument: primary,
      quoteInstrument: proxy ?? primary,
      quoteStrategy: proxy ? "etf_proxy" : "delayed_index",
      fundamentalsStrategy: "none",
      evidence: {
        astra: false,
        tavily: true,
        filings: false,
        exchangeAnnouncements: false,
      },
      numericParity: proxy ? "proxy_labeled" : "native",
    };
  }

  if (
    ticker &&
    (entity.market === "au" ||
      (entity.jurisdiction === "Australia" && ticker in AU_PRIMARY_LISTINGS))
  ) {
    const canonical = AU_PRIMARY_LISTINGS[ticker];
    const primary: InstrumentIdentity = {
      symbol: ticker,
      venue: "ASX",
      currency: "AUD",
      kind: "primary",
      label: canonical?.symbol ?? `ASX:${ticker}`,
      returnLabel: `${canonical?.symbol ?? `ASX:${ticker}`} return`,
    };
    return {
      ...base,
      companyName: canonical?.name ?? entity.name,
      primaryVenue: "ASX",
      primaryCurrency: "AUD",
      marketCalendar: "AU",
      primaryInstrument: primary,
      quoteInstrument: primary,
      quoteStrategy: "primary_asx",
      fundamentalsStrategy: "filings_web",
      evidence: {
        astra: true,
        tavily: true,
        filings: true,
        exchangeAnnouncements: true,
      },
      numericParity: "native",
    };
  }

  if (ticker && entity.market === "us") {
    const primary: InstrumentIdentity = {
      symbol: ticker,
      venue: "US",
      currency: "USD",
      kind: "primary",
      label: ticker,
      returnLabel: `${ticker} return`,
    };
    return {
      ...base,
      primaryVenue: "US",
      primaryCurrency: "USD",
      marketCalendar: "US",
      primaryInstrument: primary,
      quoteInstrument: primary,
      quoteStrategy: "primary_us",
      fundamentalsStrategy: "us_provider",
      evidence: {
        astra: true,
        tavily: true,
        filings: true,
        exchangeAnnouncements: false,
      },
      numericParity: "native",
    };
  }

  return {
    ...base,
    primaryVenue: ticker ? "UNKNOWN" : "PRIVATE",
    primaryCurrency: "NONE",
    marketCalendar: entity.jurisdiction === "Australia" ? "AU" : "US",
    quoteStrategy: "none",
    fundamentalsStrategy: ticker ? "filings_web" : "none",
    evidence: {
      astra: Boolean(ticker),
      tavily: true,
      filings: Boolean(ticker),
      exchangeAnnouncements: false,
    },
    numericParity: "unavailable",
  };
}

export function capabilitiesFor(
  entities: FinanceEntity[]
): Map<string, ListingCapability> {
  return new Map(
    entities.map((entity) => [entity.id, listingCapability(entity)])
  );
}

/** The calendar a turn should anchor to when entities span both markets. */
export function primaryCalendar(entities: FinanceEntity[]): MarketCalendar {
  const calendars = entities.map(
    (entity) => listingCapability(entity).marketCalendar
  );
  return calendars.some((calendar) => calendar === "AU") &&
    calendars.every((calendar) => calendar === "AU")
    ? "AU"
    : calendars.includes("AU")
      ? "AU"
      : "US";
}

export function spansMarkets(entities: FinanceEntity[]): boolean {
  const calendars = new Set(
    entities.map((entity) => listingCapability(entity).marketCalendar)
  );
  return calendars.size > 1;
}

/** Entities whose numbers may only be published with a proxy instrument label. */
export function proxyLabelledEntities(
  entities: FinanceEntity[]
): { entity: FinanceEntity; capability: ListingCapability }[] {
  return entities
    .map((entity) => ({ entity, capability: listingCapability(entity) }))
    .filter(({ capability }) => capability.numericParity === "proxy_labeled");
}

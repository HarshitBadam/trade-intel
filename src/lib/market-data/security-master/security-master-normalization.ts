import "server-only";

import {
  createProvenance,
  type MarketCurrency,
  type MarketDataProvider,
  type MarketVenue,
} from "../provenance";
import type {
  InstrumentIdentity,
  InstrumentKind,
  ProxyIdentity,
  SecurityMasterRecord,
} from "./security-master-types";

export function asMarketRecord(
  value: unknown
): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeTicker(
  value: string | undefined
): string | undefined {
  const ticker = value?.trim().toUpperCase();
  return ticker || undefined;
}

export function normalizeMarketDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function issuerId(venue: MarketVenue, name: string, cik?: string): string {
  return cik ? `issuer:sec:${cik}` : `issuer:${venue.toLowerCase()}:${slug(name)}`;
}

function instrumentId(venue: MarketVenue, ticker: string): string {
  return `instrument:${venue.toLowerCase()}:${ticker.toUpperCase()}`;
}

export function makeSecurityMasterRecord(input: {
  ticker: string;
  name: string;
  venue: MarketVenue;
  currency: MarketCurrency;
  kind: InstrumentKind;
  provider: MarketDataProvider;
  fetchedAt: Date;
  sourceUrl?: string;
  cik?: string;
  figi?: string;
  compositeFigi?: string;
  shareClassFigi?: string;
  exchangeCode?: string;
  jurisdiction?: string;
  sicCode?: string;
  sicDescription?: string;
  sector?: string | null;
  industry?: string | null;
  marketCap?: number | null;
  listingDate?: string;
  active?: boolean;
  primaryListing?: boolean;
  proxyFor?: ProxyIdentity;
}): SecurityMasterRecord {
  const id = issuerId(input.venue, input.name, input.cik);
  const primaryListing = input.primaryListing ?? input.kind === "primary";
  const instrument: InstrumentIdentity = {
    instrumentId: instrumentId(input.venue, input.ticker),
    issuerId: id,
    symbol: input.ticker,
    name: input.name,
    venue: input.venue,
    exchangeCode: input.exchangeCode,
    currency: input.currency,
    kind: input.kind,
    active: input.active ?? true,
    primaryListing,
    listingDate: input.listingDate,
    proxyFor: input.proxyFor,
  };
  return {
    issuer: {
      issuerId: id,
      legalName: input.name,
      cik: input.cik,
      jurisdiction: input.jurisdiction,
      sicCode: input.sicCode,
      sicDescription: input.sicDescription,
    },
    instrument,
    identifiers: {
      ticker: input.ticker,
      cik: input.cik,
      figi: input.figi,
      compositeFigi: input.compositeFigi,
      shareClassFigi: input.shareClassFigi,
      exchangeCode: input.exchangeCode,
    },
    sector: input.sector ?? null,
    industry: input.industry ?? null,
    marketCap: input.marketCap ?? null,
    provenance: [
      createProvenance({
        provider: input.provider,
        fetchedAt: input.fetchedAt,
        sourceUrl: input.sourceUrl,
        proxyFor: input.proxyFor?.symbol,
        proxyKind: input.proxyFor?.kind,
        notes: input.proxyFor ? [input.proxyFor.note] : undefined,
      }),
    ],
    name: input.name,
    venue: input.venue,
    currency: input.currency,
    instrumentKind: input.kind,
    active: instrument.active,
    primaryListing,
    listingDate: input.listingDate ?? null,
  };
}

import type {
  DataProvenance,
  MarketCurrency,
  MarketDataProvider,
  MarketVenue,
} from "./provenance";
import type { SecEdgarDependencies } from "./sec-edgar-types";

export type SecurityIdentifier = {
  ticker: string;
  cik?: string;
  figi?: string;
  compositeFigi?: string;
  shareClassFigi?: string;
  isin?: string;
  cusip?: string;
  exchangeCode?: string;
};

export type IssuerIdentity = {
  issuerId: string;
  legalName: string;
  cik?: string;
  jurisdiction?: string;
  sicCode?: string;
  sicDescription?: string;
};

export type InstrumentKind =
  | "primary"
  | "adr"
  | "etf"
  | "index"
  | "fund"
  | "other";

export type ProxyIdentity = {
  kind: "adr" | "etf";
  symbol: string;
  issuerId?: string;
  instrumentId?: string;
  note: string;
};

export type InstrumentIdentity = {
  instrumentId: string;
  issuerId?: string;
  symbol: string;
  name: string;
  venue: MarketVenue;
  exchangeCode?: string;
  currency: MarketCurrency;
  kind: InstrumentKind;
  active: boolean;
  primaryListing: boolean;
  listingDate?: string;
  proxyFor?: ProxyIdentity;
};

export type SecurityMasterRecord = {
  issuer: IssuerIdentity;
  instrument: InstrumentIdentity;
  identifiers: SecurityIdentifier;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  provenance: DataProvenance[];
  name: string;
  venue: MarketVenue;
  currency: MarketCurrency;
  instrumentKind: InstrumentKind;
  active: boolean;
  primaryListing: boolean;
  listingDate: string | null;
};

export type CorporateActionKind =
  | "split"
  | "reverse_split"
  | "cash_dividend"
  | "stock_dividend"
  | "symbol_change"
  | "merger";

export type CorporateAction = {
  id: string;
  issuerId?: string;
  instrumentId?: string;
  ticker: string;
  kind: CorporateActionKind;
  exDate: string;
  declarationDate?: string;
  recordDate?: string;
  payDate?: string;
  /** New shares divided by old shares (4-for-1 = 4; 1-for-10 = 0.1). */
  ratio?: number;
  amount?: number;
  currency?: MarketCurrency;
  fromSymbol?: string;
  toSymbol?: string;
  description: string;
  provenance: DataProvenance;
};

export type CorporateActionRange = {
  startSession: string;
  endSession: string;
};

export type CorporateActionProviderDiagnostic = {
  provider: MarketDataProvider;
  status: "succeeded" | "failed" | "unsupported";
  actionCount: number;
  error?: string;
};

export type CorporateActionRetrievalResult = {
  actions: CorporateAction[];
  range: CorporateActionRange;
  status: "complete" | "partial" | "unavailable";
  diagnostics: CorporateActionProviderDiagnostic[];
};

export type SecurityMasterSnapshot = {
  security: SecurityMasterRecord | null;
  corporateActions: CorporateAction[];
  corporateActionRetrieval?: CorporateActionRetrievalResult;
  asOf: string;
  status: "complete" | "partial" | "unavailable";
};

export type ResolveSecurityQuery = {
  ticker?: string;
  cik?: string;
  name?: string;
  /** Labels a separately traded ADR/ETF without merging its identity. */
  proxyFor?: ProxyIdentity;
};

export interface SecurityMasterProviderAdapter {
  provider: MarketDataProvider;
  resolve(
    query: Readonly<ResolveSecurityQuery>,
    venue?: MarketVenue
  ): Promise<SecurityMasterRecord | null>;
  corporateActions?(
    ticker: string,
    range: Readonly<CorporateActionRange>,
    venue?: MarketVenue
  ): Promise<CorporateAction[]>;
}

export type SecurityMasterJsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type SecurityMasterOptions = {
  venue?: MarketVenue;
  adapters?: readonly SecurityMasterProviderAdapter[];
  polygonFetch?: (url: string) => Promise<SecurityMasterJsonResponse>;
  yahooFetch?: (
    url: string,
    init: RequestInit
  ) => Promise<SecurityMasterJsonResponse>;
  sec?: SecEdgarDependencies;
  now?: () => Date;
  polygonAvailable?: boolean;
};

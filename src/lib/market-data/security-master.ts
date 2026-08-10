import "server-only";

import { hasPolygon } from "@/lib/config";
import { polygonFetch } from "./polygon";
import {
  getSecSubmissions,
  resolveCik,
  type SecEdgarDependencies,
} from "./sec-edgar";
import {
  createProvenance,
  type DataProvenance,
  type MarketCurrency,
  type MarketDataProvider,
  type MarketVenue,
} from "./provenance";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const REQUEST_TIMEOUT_MS = 8_000;
const YAHOO_INDEX_SYMBOLS: Record<string, string> = {
  GSPC: "^GSPC",
  SPX: "^GSPC",
  IXIC: "^IXIC",
  DJI: "^DJI",
  RUT: "^RUT",
  AXJO: "^AXJO",
};

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

export type InstrumentKind = "primary" | "adr" | "etf" | "index" | "fund" | "other";

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
  /** Convenience fields preserve a compact record shape for simple consumers. */
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
  /** Explicitly labels a separately traded ADR/ETF rather than conflating it. */
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

type JsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type SecurityMasterOptions = {
  venue?: MarketVenue;
  adapters?: readonly SecurityMasterProviderAdapter[];
  polygonFetch?: (url: string) => Promise<JsonResponse>;
  yahooFetch?: (url: string, init: RequestInit) => Promise<JsonResponse>;
  sec?: SecEdgarDependencies;
  now?: () => Date;
  polygonAvailable?: boolean;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function cleanTicker(value: string | undefined): string | undefined {
  const ticker = value?.trim().toUpperCase();
  return ticker || undefined;
}

function validDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function issuerId(
  venue: MarketVenue,
  name: string,
  cik?: string
): string {
  return cik ? `issuer:sec:${cik}` : `issuer:${venue.toLowerCase()}:${slug(name)}`;
}

function instrumentId(venue: MarketVenue, ticker: string): string {
  return `instrument:${venue.toLowerCase()}:${ticker.toUpperCase()}`;
}

function makeRecord(input: {
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

function polygonKind(type: string, name: string): InstrumentKind {
  const upper = `${type} ${name}`.toUpperCase();
  if (/\bADR\b|ADRC|ADRP|ADRR/.test(upper)) return "adr";
  if (/ETF|ETV/.test(upper)) return "etf";
  if (/INDEX/.test(upper)) return "index";
  if (/FUND/.test(upper)) return "fund";
  return "primary";
}

export function createPolygonSecurityMasterAdapter(
  fetcher: (url: string) => Promise<JsonResponse> = polygonFetch,
  now: () => Date = () => new Date()
): SecurityMasterProviderAdapter {
  async function fetchAll(url: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    let next: string | undefined = url;
    while (next) {
      if (visited.has(next)) throw new Error("Polygon pagination cycle");
      visited.add(next);
      const response = await fetcher(next);
      if (!response.ok) {
        if (response.status === 404) return output;
        throw new Error(`Polygon reference API responded with ${response.status}`);
      }
      const payload = object(await response.json());
      if (Array.isArray(payload?.results)) {
        output.push(
          ...payload.results.filter(
            (value): value is Record<string, unknown> => object(value) !== null
          )
        );
      }
      next = typeof payload?.next_url === "string" ? payload.next_url : undefined;
    }
    return output;
  }

  return {
    provider: "polygon",
    async resolve(query, requestedVenue) {
      const ticker = cleanTicker(query.ticker);
      if (!ticker || (requestedVenue && requestedVenue !== "US")) return null;
      const url = `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(ticker)}`;
      const response = await fetcher(url);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Polygon ticker detail responded with ${response.status}`);
      }
      const payload = object(await response.json());
      const result = object(payload?.results);
      if (!result || String(result.ticker ?? "").toUpperCase() !== ticker) return null;
      const name = String(result.name ?? ticker);
      const cik =
        typeof result.cik === "string"
          ? result.cik.replace(/\D/g, "").padStart(10, "0")
          : undefined;
      const kind = polygonKind(String(result.type ?? ""), name);
      return makeRecord({
        ticker,
        name,
        venue: "US",
        currency: "USD",
        kind,
        provider: "polygon",
        fetchedAt: now(),
        sourceUrl: url,
        cik,
        compositeFigi:
          typeof result.composite_figi === "string"
            ? result.composite_figi
            : undefined,
        shareClassFigi:
          typeof result.share_class_figi === "string"
            ? result.share_class_figi
            : undefined,
        exchangeCode:
          typeof result.primary_exchange === "string"
            ? result.primary_exchange
            : undefined,
        jurisdiction:
          typeof result.locale === "string" ? result.locale.toUpperCase() : "US",
        sicCode:
          result.sic_code !== undefined ? String(result.sic_code) : undefined,
        sicDescription:
          typeof result.sic_description === "string"
            ? result.sic_description
            : undefined,
        sector:
          typeof result.sic_description === "string"
            ? result.sic_description
            : null,
        marketCap: finite(result.market_cap) ?? null,
        listingDate: validDate(result.list_date),
        active: result.active !== false,
        primaryListing: kind === "primary",
        proxyFor: query.proxyFor,
      });
    },
    async corporateActions(ticker, range, requestedVenue) {
      if (requestedVenue && requestedVenue !== "US") return [];
      const splitParams = new URLSearchParams({
        ticker: ticker.toUpperCase(),
        "execution_date.gte": range.startSession,
        "execution_date.lte": range.endSession,
        order: "asc",
        limit: "1000",
        sort: "execution_date",
      });
      const dividendParams = new URLSearchParams({
        ticker: ticker.toUpperCase(),
        "ex_dividend_date.gte": range.startSession,
        "ex_dividend_date.lte": range.endSession,
        order: "asc",
        limit: "1000",
        sort: "ex_dividend_date",
      });
      const [splits, dividends] = await Promise.all([
        fetchAll(`https://api.polygon.io/v3/reference/splits?${splitParams}`),
        fetchAll(`https://api.polygon.io/v3/reference/dividends?${dividendParams}`),
      ]);
      const fetchedAt = now();
      const actions: CorporateAction[] = [];
      for (const row of splits) {
        const exDate = validDate(row.execution_date);
        const splitFrom = finite(row.split_from);
        const splitTo = finite(row.split_to);
        if (!exDate || !splitFrom || !splitTo) continue;
        const ratio = splitTo / splitFrom;
        actions.push({
          id: "",
          ticker: ticker.toUpperCase(),
          kind: ratio < 1 ? "reverse_split" : "split",
          exDate,
          ratio,
          description: `${splitTo}-for-${splitFrom} ${
            ratio < 1 ? "reverse " : ""
          }split`,
          provenance: createProvenance({
            provider: "polygon",
            fetchedAt,
            sourceUrl: "https://api.polygon.io/v3/reference/splits",
          }),
        });
      }
      for (const row of dividends) {
        const exDate = validDate(row.ex_dividend_date);
        const amount = finite(row.cash_amount);
        if (!exDate || amount === undefined) continue;
        const currency =
          typeof row.currency === "string"
            ? (row.currency.toUpperCase() as MarketCurrency)
            : "USD";
        actions.push({
          id: "",
          ticker: ticker.toUpperCase(),
          kind:
            String(row.dividend_type ?? "").toUpperCase() === "SC"
              ? "stock_dividend"
              : "cash_dividend",
          exDate,
          declarationDate: validDate(row.declaration_date),
          recordDate: validDate(row.record_date),
          payDate: validDate(row.pay_date),
          amount,
          currency,
          description: `${amount} ${currency} dividend`,
          provenance: createProvenance({
            provider: "polygon",
            fetchedAt,
            sourceUrl: "https://api.polygon.io/v3/reference/dividends",
          }),
        });
      }
      return actions;
    },
  };
}

export function parseYahooCorporateActions(
  ticker: string,
  payload: unknown,
  provenance: DataProvenance
): CorporateAction[] {
  const root = object(payload);
  const chart = object(root?.chart);
  const result = Array.isArray(chart?.result) ? object(chart.result[0]) : null;
  const events = object(result?.events);
  const output: CorporateAction[] = [];
  for (const raw of Object.values(object(events?.dividends) ?? {})) {
    const row = object(raw);
    const seconds = finite(row?.date);
    const amount = finite(row?.amount);
    if (seconds === undefined || amount === undefined) continue;
    output.push({
      id: "",
      ticker: ticker.toUpperCase(),
      kind: "cash_dividend",
      exDate: new Date(seconds * 1_000).toISOString().slice(0, 10),
      amount,
      currency: "AUD",
      description: `${amount} AUD dividend`,
      provenance,
    });
  }
  for (const raw of Object.values(object(events?.splits) ?? {})) {
    const row = object(raw);
    const seconds = finite(row?.date);
    const numerator = finite(row?.numerator);
    const denominator = finite(row?.denominator);
    const ratio =
      numerator !== undefined && denominator
        ? numerator / denominator
        : typeof row?.splitRatio === "string" && row.splitRatio.includes(":")
          ? Number(row.splitRatio.split(":")[0]) /
            Number(row.splitRatio.split(":")[1])
          : undefined;
    if (seconds === undefined || !ratio || !Number.isFinite(ratio)) continue;
    output.push({
      id: "",
      ticker: ticker.toUpperCase(),
      kind: ratio < 1 ? "reverse_split" : "split",
      exDate: new Date(seconds * 1_000).toISOString().slice(0, 10),
      ratio,
      description: `${ratio}:1 ${ratio < 1 ? "reverse " : ""}split`,
      provenance,
    });
  }
  return normalizeCorporateActions(output);
}

export function createYahooSecurityMasterAdapter(
  fetcher: (url: string, init: RequestInit) => Promise<JsonResponse> = fetch,
  now: () => Date = () => new Date()
): SecurityMasterProviderAdapter {
  async function chart(
    ticker: string,
    startSession: string,
    endSession: string,
    venue: "ASX" | "INDEX"
  ): Promise<{ payload: unknown; url: string }> {
    const symbol =
      venue === "INDEX"
        ? YAHOO_INDEX_SYMBOLS[ticker] ?? ticker
        : ticker.endsWith(".AX")
          ? ticker
          : `${ticker}.AX`;
    const start = Math.floor(Date.parse(`${startSession}T00:00:00.000Z`) / 1_000);
    const end = Math.floor(Date.parse(`${endSession}T23:59:59.999Z`) / 1_000);
    const url = new URL(`${YAHOO_CHART_URL}${encodeURIComponent(symbol)}`);
    url.searchParams.set("period1", String(start));
    url.searchParams.set("period2", String(end));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "div,splits");
    url.searchParams.set("includeAdjustedClose", "true");
    const response = await fetcher(url.toString(), {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 TradeIntel-StockSage/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Yahoo responded with ${response.status}`);
    return { payload: await response.json(), url: url.toString() };
  }

  return {
    provider: "yahoo",
    async resolve(query, requestedVenue) {
      const rootTicker = cleanTicker(query.ticker)?.replace(/\.AX$/, "");
      if (
        !rootTicker ||
        (requestedVenue &&
          requestedVenue !== "ASX" &&
          requestedVenue !== "INDEX")
      ) {
        return null;
      }
      const venue = requestedVenue === "INDEX" ? "INDEX" : "ASX";
      const today = now().toISOString().slice(0, 10);
      const start = new Date(now().getTime() - 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const { payload, url } = await chart(rootTicker, start, today, venue);
      const root = object(payload);
      const chartResult = object(root?.chart);
      const result = Array.isArray(chartResult?.result)
        ? object(chartResult.result[0])
        : null;
      const meta = object(result?.meta);
      const expected =
        venue === "INDEX"
          ? YAHOO_INDEX_SYMBOLS[rootTicker] ?? rootTicker
          : `${rootTicker}.AX`;
      const exchange = String(
        meta?.exchangeName ?? meta?.fullExchangeName ?? ""
      ).toUpperCase();
      if (
        !meta ||
        String(meta.symbol ?? "").toUpperCase() !== expected ||
        (venue === "ASX" &&
          (String(meta.currency ?? "").toUpperCase() !== "AUD" ||
            !["ASX", "ASX_ALL_MARKETS"].includes(exchange)))
      ) {
        return null;
      }
      const name = String(meta.longName ?? meta.shortName ?? query.name ?? rootTicker);
      const currency =
        venue === "ASX"
          ? "AUD"
          : ((String(meta.currency ?? "USD").toUpperCase() ||
              "USD") as MarketCurrency);
      return makeRecord({
        ticker: expected,
        name,
        venue,
        currency,
        kind: venue === "INDEX" ? "index" : "primary",
        provider: "yahoo",
        fetchedAt: now(),
        sourceUrl: url,
        exchangeCode: venue === "ASX" ? "ASX" : exchange || undefined,
        jurisdiction: venue === "ASX" ? "AU" : undefined,
        active: true,
        primaryListing: venue === "ASX",
        proxyFor: query.proxyFor,
      });
    },
    async corporateActions(ticker, range, requestedVenue) {
      if (requestedVenue && requestedVenue !== "ASX") return [];
      const rootTicker = ticker.toUpperCase().replace(/\.AX$/, "");
      const { payload, url } = await chart(
        rootTicker,
        range.startSession,
        range.endSession,
        "ASX"
      );
      return parseYahooCorporateActions(
        rootTicker,
        payload,
        createProvenance({
          provider: "yahoo",
          fetchedAt: now(),
          sourceUrl: url,
          requestStart: range.startSession,
          requestEnd: range.endSession,
          delayed: true,
        })
      );
    },
  };
}

export function createSecSecurityMasterAdapter(
  dependencies: SecEdgarDependencies = {}
): SecurityMasterProviderAdapter {
  return {
    provider: "sec_edgar",
    async resolve(query, requestedVenue) {
      if (requestedVenue && requestedVenue !== "US") return null;
      const ticker = cleanTicker(query.ticker);
      const cik = query.cik
        ? query.cik.replace(/\D/g, "").padStart(10, "0")
        : ticker
          ? await resolveCik(ticker, dependencies)
          : null;
      if (!cik) return null;
      const submission = await getSecSubmissions(cik, dependencies);
      if (
        ticker &&
        submission.tickers.length > 0 &&
        !submission.tickers.includes(ticker)
      ) {
        return null;
      }
      const symbol = ticker ?? submission.tickers[0];
      if (!symbol) return null;
      const exchange = submission.exchanges[submission.tickers.indexOf(symbol)];
      const fetchedAt = dependencies.now?.() ?? new Date();
      return makeRecord({
        ticker: symbol,
        name: submission.name || query.name || symbol,
        venue: "US",
        currency: "USD",
        kind: "primary",
        provider: "sec_edgar",
        fetchedAt,
        sourceUrl: submission.provenance.sourceUrl,
        cik,
        exchangeCode: exchange,
        jurisdiction: submission.stateOfIncorporation,
        sicCode: submission.sic,
        sicDescription: submission.sicDescription,
        sector: submission.sicDescription ?? null,
        active: true,
        primaryListing: true,
        proxyFor: query.proxyFor,
      });
    },
  };
}

function defaultAdapters(options: SecurityMasterOptions): SecurityMasterProviderAdapter[] {
  const now = options.now ?? (() => new Date());
  if (options.venue === "ASX") {
    return [createYahooSecurityMasterAdapter(options.yahooFetch ?? fetch, now)];
  }
  const adapters: SecurityMasterProviderAdapter[] = [];
  if (
    options.polygonAvailable ??
    (Boolean(options.polygonFetch) || hasPolygon)
  ) {
    adapters.push(
      createPolygonSecurityMasterAdapter(options.polygonFetch ?? polygonFetch, now)
    );
  }
  if (options.venue !== "INDEX") {
    adapters.push(createSecSecurityMasterAdapter(options.sec));
  }
  if (options.venue === "INDEX") {
    adapters.push(createYahooSecurityMasterAdapter(options.yahooFetch ?? fetch, now));
  }
  return adapters;
}

export async function resolveSecurity(
  input: ResolveSecurityQuery,
  options: SecurityMasterOptions = {}
): Promise<SecurityMasterRecord | null> {
  const query: ResolveSecurityQuery = {
    ...input,
    ticker: cleanTicker(input.ticker),
    cik: input.cik?.replace(/\D/g, "").padStart(10, "0"),
    name: input.name?.trim() || undefined,
  };
  if (!query.ticker && !query.cik && !query.name) {
    throw new Error("ticker, cik, or name is required");
  }
  for (const adapter of options.adapters ?? defaultAdapters(options)) {
    try {
      const result = await adapter.resolve(query, options.venue);
      if (result) return result;
    } catch {
      // A provider outage may fall through to the next identity source.
    }
  }
  return null;
}

function actionIdentity(action: CorporateAction): string {
  return [
    "action",
    action.ticker.toUpperCase(),
    action.kind,
    action.exDate,
    action.ratio === undefined ? "" : String(action.ratio),
    action.amount === undefined ? "" : String(action.amount),
    action.currency ?? "",
    action.fromSymbol ?? "",
    action.toSymbol ?? "",
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function normalizeCorporateActions(
  actions: readonly CorporateAction[]
): CorporateAction[] {
  const normalized = new Map<string, CorporateAction>();
  for (const action of actions) {
    const ticker = action.ticker.trim().toUpperCase();
    if (
      !ticker ||
      !/^\d{4}-\d{2}-\d{2}$/.test(action.exDate) ||
      (action.ratio !== undefined &&
        (!Number.isFinite(action.ratio) || action.ratio <= 0)) ||
      (action.amount !== undefined && !Number.isFinite(action.amount))
    ) {
      continue;
    }
    const candidate = { ...action, ticker };
    const id = actionIdentity(candidate);
    normalized.set(id, { ...candidate, id });
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.exDate.localeCompare(right.exDate) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}

export async function getCorporateActions(
  ticker: string,
  range: CorporateActionRange,
  options: SecurityMasterOptions = {}
): Promise<CorporateAction[]> {
  return (await getCorporateActionsResult(ticker, range, options)).actions;
}

export async function getCorporateActionsResult(
  ticker: string,
  range: CorporateActionRange,
  options: SecurityMasterOptions = {}
): Promise<CorporateActionRetrievalResult> {
  const symbol = cleanTicker(ticker);
  if (!symbol) throw new Error("ticker is required");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(range.startSession) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(range.endSession) ||
    range.startSession > range.endSession
  ) {
    throw new Error("corporate-action range must be ordered YYYY-MM-DD dates");
  }
  const adapters = options.adapters ?? defaultAdapters(options);
  const outcomes = await Promise.all(
    adapters.map(async (adapter) => {
      if (!adapter.corporateActions) {
        return {
          actions: [] as CorporateAction[],
          diagnostic: {
            provider: adapter.provider,
            status: "unsupported" as const,
            actionCount: 0,
          },
        };
      }
      try {
        const actions = await adapter.corporateActions(
          symbol,
          range,
          options.venue
        );
        return {
          actions,
          diagnostic: {
            provider: adapter.provider,
            status: "succeeded" as const,
            actionCount: actions.length,
          },
        };
      } catch (error) {
        return {
          actions: [] as CorporateAction[],
          diagnostic: {
            provider: adapter.provider,
            status: "failed" as const,
            actionCount: 0,
            error:
              error instanceof Error
                ? error.message.slice(0, 200)
                : "unknown provider error",
          },
        };
      }
    })
  );
  const actions = normalizeCorporateActions(
    outcomes.flatMap((outcome) => outcome.actions)
  ).filter(
    (action) =>
      action.exDate >= range.startSession && action.exDate <= range.endSession
  );
  const diagnostics = outcomes.map((outcome) => outcome.diagnostic);
  const capable = diagnostics.filter(
    (diagnostic) => diagnostic.status !== "unsupported"
  );
  const succeeded = capable.filter(
    (diagnostic) => diagnostic.status === "succeeded"
  ).length;
  const failed = capable.filter(
    (diagnostic) => diagnostic.status === "failed"
  ).length;
  return {
    actions,
    range: { ...range },
    status:
      capable.length === 0 || succeeded === 0
        ? "unavailable"
        : failed > 0
          ? "partial"
          : "complete",
    diagnostics,
  };
}

export async function getSecurityMasterSnapshot(
  ticker: string,
  range?: CorporateActionRange,
  options: SecurityMasterOptions = {}
): Promise<SecurityMasterSnapshot> {
  const now = options.now ?? (() => new Date());
  const security = await resolveSecurity({ ticker }, options);
  if (!security) {
    return {
      security: null,
      corporateActions: [],
      asOf: now().toISOString(),
      status: "unavailable",
    };
  }
  const actionRetrieval = range
    ? await getCorporateActionsResult(ticker, range, options)
    : undefined;
  return {
    security,
    corporateActions: actionRetrieval?.actions ?? [],
    corporateActionRetrieval: actionRetrieval,
    asOf: now().toISOString(),
    status:
      !actionRetrieval || actionRetrieval.status === "complete"
        ? "complete"
        : "partial",
  };
}

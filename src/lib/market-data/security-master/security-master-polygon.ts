import "server-only";

import { polygonFetch } from "../providers/polygon";
import {
  createProvenance,
  type MarketCurrency,
} from "../provenance";
import {
  asMarketRecord,
  finiteNumber,
  makeSecurityMasterRecord,
  normalizeMarketDate,
  normalizeTicker,
} from "./security-master-normalization";
import type {
  CorporateAction,
  InstrumentKind,
  SecurityMasterJsonResponse,
  SecurityMasterProviderAdapter,
} from "./security-master-types";

function polygonKind(type: string, name: string): InstrumentKind {
  const upper = `${type} ${name}`.toUpperCase();
  if (/\bADR\b|ADRC|ADRP|ADRR/.test(upper)) return "adr";
  if (/ETF|ETV/.test(upper)) return "etf";
  if (/INDEX/.test(upper)) return "index";
  if (/FUND/.test(upper)) return "fund";
  return "primary";
}

export function createPolygonSecurityMasterAdapter(
  fetcher: (url: string) => Promise<SecurityMasterJsonResponse> = polygonFetch,
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
      const payload = asMarketRecord(await response.json());
      if (Array.isArray(payload?.results)) {
        for (const raw of payload.results) {
          const row = asMarketRecord(raw);
          if (row) output.push(row);
        }
      }
      next = typeof payload?.next_url === "string" ? payload.next_url : undefined;
    }
    return output;
  }

  return {
    provider: "polygon",
    async resolve(query, requestedVenue) {
      const ticker = normalizeTicker(query.ticker);
      if (!ticker || (requestedVenue && requestedVenue !== "US")) return null;
      const url =
        `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(ticker)}`;
      const response = await fetcher(url);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Polygon ticker detail responded with ${response.status}`);
      }
      const payload = asMarketRecord(await response.json());
      const result = asMarketRecord(payload?.results);
      if (!result || String(result.ticker ?? "").toUpperCase() !== ticker) {
        return null;
      }
      const name = String(result.name ?? ticker);
      const cik =
        typeof result.cik === "string"
          ? result.cik.replace(/\D/g, "").padStart(10, "0")
          : undefined;
      const kind = polygonKind(String(result.type ?? ""), name);
      return makeSecurityMasterRecord({
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
        marketCap: finiteNumber(result.market_cap) ?? null,
        listingDate: normalizeMarketDate(result.list_date),
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
        const exDate = normalizeMarketDate(row.execution_date);
        const splitFrom = finiteNumber(row.split_from);
        const splitTo = finiteNumber(row.split_to);
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
        const exDate = normalizeMarketDate(row.ex_dividend_date);
        const amount = finiteNumber(row.cash_amount);
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
          declarationDate: normalizeMarketDate(row.declaration_date),
          recordDate: normalizeMarketDate(row.record_date),
          payDate: normalizeMarketDate(row.pay_date),
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

import "server-only";

import { normalizeCorporateActions } from "./corporate-action-normalization";
import {
  createProvenance,
  type DataProvenance,
  type MarketCurrency,
} from "../provenance";
import {
  asMarketRecord,
  finiteNumber,
  makeSecurityMasterRecord,
  normalizeTicker,
} from "./security-master-normalization";
import type {
  CorporateAction,
  SecurityMasterJsonResponse,
  SecurityMasterProviderAdapter,
} from "./security-master-types";

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

export function parseYahooCorporateActions(
  ticker: string,
  payload: unknown,
  provenance: DataProvenance
): CorporateAction[] {
  const root = asMarketRecord(payload);
  const chart = asMarketRecord(root?.chart);
  const result = Array.isArray(chart?.result)
    ? asMarketRecord(chart.result[0])
    : null;
  const events = asMarketRecord(result?.events);
  const output: CorporateAction[] = [];

  for (const raw of Object.values(asMarketRecord(events?.dividends) ?? {})) {
    const row = asMarketRecord(raw);
    const seconds = finiteNumber(row?.date);
    const amount = finiteNumber(row?.amount);
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

  for (const raw of Object.values(asMarketRecord(events?.splits) ?? {})) {
    const row = asMarketRecord(raw);
    const seconds = finiteNumber(row?.date);
    const numerator = finiteNumber(row?.numerator);
    const denominator = finiteNumber(row?.denominator);
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
  fetcher: (
    url: string,
    init: RequestInit
  ) => Promise<SecurityMasterJsonResponse> = fetch,
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
    const start = Math.floor(
      Date.parse(`${startSession}T00:00:00.000Z`) / 1_000
    );
    const end = Math.floor(
      Date.parse(`${endSession}T23:59:59.999Z`) / 1_000
    );
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
      const rootTicker = normalizeTicker(query.ticker)?.replace(/\.AX$/, "");
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
      const root = asMarketRecord(payload);
      const chartResult = asMarketRecord(root?.chart);
      const result = Array.isArray(chartResult?.result)
        ? asMarketRecord(chartResult.result[0])
        : null;
      const meta = asMarketRecord(result?.meta);
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
      const name = String(
        meta.longName ?? meta.shortName ?? query.name ?? rootTicker
      );
      const currency =
        venue === "ASX"
          ? "AUD"
          : ((String(meta.currency ?? "USD").toUpperCase() ||
              "USD") as MarketCurrency);
      return makeSecurityMasterRecord({
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

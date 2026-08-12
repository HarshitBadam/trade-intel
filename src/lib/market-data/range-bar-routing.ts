import type { RangeBarRequest } from "./provenance";
import type { RangeBarProviderName } from "./range-bar-types";

const STOOQ_INDEX_SYMBOLS: Record<string, string> = {
  GSPC: "^spx",
  SPX: "^spx",
  IXIC: "^ndq",
  DJI: "^dji",
  RUT: "^rut",
};

const YAHOO_INDEX_SYMBOLS: Record<string, string> = {
  GSPC: "^GSPC",
  SPX: "^GSPC",
  IXIC: "^IXIC",
  DJI: "^DJI",
  RUT: "^RUT",
  AXJO: "^AXJO",
};

export function routeBarProviders(
  request: RangeBarRequest
): RangeBarProviderName[] {
  if (request.venue === "ASX") return ["yahoo"];
  if (request.venue === "INDEX") {
    if (request.ticker === "AXJO") return ["yahoo"];
    return request.granularity === "1Day" ? ["stooq", "yahoo"] : ["yahoo"];
  }
  if (request.venue === "US") {
    return request.granularity === "1Day" && request.adjusted !== false
      ? ["yahoo", "polygon", "alpaca"]
      : ["alpaca", "polygon", "yahoo"];
  }
  return [];
}

export function rangeBarProviderSymbol(
  request: RangeBarRequest,
  provider: RangeBarProviderName
): string {
  if (request.instrumentSymbol) return request.instrumentSymbol;
  if (provider === "yahoo" && request.venue === "ASX") {
    return request.ticker.endsWith(".AX") ? request.ticker : `${request.ticker}.AX`;
  }
  if (provider === "yahoo" && request.venue === "INDEX") {
    return YAHOO_INDEX_SYMBOLS[request.ticker] ?? request.ticker;
  }
  if (provider === "stooq" && request.venue === "INDEX") {
    return STOOQ_INDEX_SYMBOLS[request.ticker] ?? request.ticker;
  }
  return request.ticker;
}

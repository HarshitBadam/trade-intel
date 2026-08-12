import { createProvenance } from "./provenance";
import {
  sessionForTimestamp,
  sessionRangeToBounds,
} from "./range-bar-calendar";
import { chunkRangeBarRequest } from "./range-bar-coverage";
import { rangeBarProviderSymbol } from "./range-bar-routing";
import type {
  JsonResponse,
  OhlcvBar,
  RangeBarProvider,
} from "./range-bar-types";
import { finiteNumber, objectValue } from "./range-bar-values";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const FETCH_TIMEOUT_MS = 8_000;

export function createYahooRangeBarProvider(
  fetcher: (url: string, init: RequestInit) => Promise<JsonResponse>,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    const symbol = rangeBarProviderSymbol(request, "yahoo");
    const bars: OhlcvBar[] = [];
    let adjustedAvailable = request.adjusted === false;
    let lastUrl: string | undefined;
    for (const chunk of chunkRangeBarRequest(request)) {
      const bounds = sessionRangeToBounds(chunk);
      const url = new URL(`${YAHOO_CHART_URL}${encodeURIComponent(symbol)}`);
      url.searchParams.set("period1", String(Math.floor(bounds.fromMs / 1_000)));
      url.searchParams.set("period2", String(Math.ceil(bounds.toMs / 1_000)));
      url.searchParams.set(
        "interval",
        request.granularity === "1Day"
          ? "1d"
          : request.granularity === "15Min"
            ? "15m"
            : "1m"
      );
      url.searchParams.set("events", "div,splits");
      url.searchParams.set(
        "includeAdjustedClose",
        String(request.adjusted !== false)
      );
      lastUrl = url.toString();
      const response = await fetcher(lastUrl, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 TradeIntel-StockSage/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Yahoo bars responded with ${response.status}`);
      }
      const root = objectValue(await response.json());
      const chart = objectValue(root?.chart);
      if (!chart || chart.error != null || !Array.isArray(chart.result)) {
        throw new Error("Yahoo returned no chart result");
      }
      const result = objectValue(chart.result[0]);
      const meta = objectValue(result?.meta);
      if (
        !result ||
        !meta ||
        String(meta.symbol ?? "").toUpperCase() !== symbol
      ) {
        throw new Error("Yahoo returned a different instrument");
      }
      if (
        request.venue === "ASX" &&
        (String(meta.currency ?? "").toUpperCase() !== "AUD" ||
          !["ASX", "ASX_ALL_MARKETS"].includes(
            String(meta.exchangeName ?? meta.fullExchangeName ?? "").toUpperCase()
          ))
      ) {
        throw new Error("Yahoo ASX identity validation failed");
      }
      const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
      const indicators = objectValue(result.indicators);
      const quote = Array.isArray(indicators?.quote)
        ? objectValue(indicators.quote[0])
        : null;
      const adjusted = Array.isArray(indicators?.adjclose)
        ? objectValue(indicators.adjclose[0])
        : null;
      const opens = Array.isArray(quote?.open) ? quote.open : [];
      const highs = Array.isArray(quote?.high) ? quote.high : [];
      const lows = Array.isArray(quote?.low) ? quote.low : [];
      const closes = Array.isArray(quote?.close) ? quote.close : [];
      const volumes = Array.isArray(quote?.volume) ? quote.volume : [];
      const adjustedCloses = Array.isArray(adjusted?.adjclose)
        ? adjusted.adjclose
        : [];
      bars.push(
        ...timestamps.flatMap((rawTimestamp, index): OhlcvBar[] => {
          const seconds = finiteNumber(rawTimestamp);
          const rawOpen = finiteNumber(opens[index]);
          const rawHigh = finiteNumber(highs[index]);
          const rawLow = finiteNumber(lows[index]);
          const rawClose = finiteNumber(closes[index]);
          const volume = finiteNumber(volumes[index]) ?? 0;
          if (
            seconds === null ||
            rawOpen === null ||
            rawHigh === null ||
            rawLow === null ||
            rawClose === null ||
            rawClose <= 0
          ) {
            return [];
          }
          const adjustedClose = finiteNumber(adjustedCloses[index]);
          if (
            request.adjusted !== false &&
            (adjustedClose === null || adjustedClose <= 0)
          ) {
            return [];
          }
          const factor =
            request.adjusted !== false
              ? (adjustedClose as number) / rawClose
              : 1;
          if (request.adjusted !== false && adjustedClose !== null) {
            adjustedAvailable = true;
          }
          const timestamp = new Date(seconds * 1_000).toISOString();
          return [
            {
              timestamp,
              session: sessionForTimestamp(timestamp, request.calendar),
              open: rawOpen * factor,
              high: rawHigh * factor,
              low: rawLow * factor,
              close: rawClose * factor,
              volume,
            },
          ];
        })
      );
    }
    return {
      bars,
      partial: request.adjusted !== false && !adjustedAvailable,
      reason:
        request.adjusted !== false && !adjustedAvailable
          ? "adjustment_unavailable"
          : undefined,
      provenance: createProvenance({
        provider: "yahoo",
        fetchedAt: now(),
        sourceUrl: lastUrl,
        adjustment:
          request.adjusted === false
            ? "none"
            : adjustedAvailable
              ? "split+dividend"
              : "provider_default",
        requestStart: request.startSession,
        requestEnd: request.endSession,
        delayed: true,
      }),
    };
  };
}

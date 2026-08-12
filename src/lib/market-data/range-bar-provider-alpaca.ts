import {
  getAlpacaBars,
  type AlpacaBar,
  type AlpacaTimeframe,
} from "./alpaca";
import { createProvenance } from "./provenance";
import { sessionRangeToBounds } from "./range-bar-calendar";
import { chunkRangeBarRequest } from "./range-bar-coverage";
import { rangeBarProviderSymbol } from "./range-bar-routing";
import type { RangeBarProvider } from "./range-bar-types";
import { alpacaBarToOhlcv } from "./range-bar-values";

export function createAlpacaRangeBarProvider(
  fetcher: typeof getAlpacaBars,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    if (request.adjusted === false) {
      throw new Error("the existing Alpaca adapter only exposes adjusted bars");
    }
    const raw: AlpacaBar[] = [];
    for (const chunk of chunkRangeBarRequest(request)) {
      const bounds = sessionRangeToBounds(chunk);
      raw.push(
        ...(await fetcher(
          rangeBarProviderSymbol(request, "alpaca"),
          request.granularity as AlpacaTimeframe,
          bounds.fromISO,
          bounds.toISO
        ))
      );
    }
    return {
      bars: raw.map((bar) => alpacaBarToOhlcv(bar, request.calendar)),
      provenance: createProvenance({
        provider: "alpaca",
        fetchedAt: now(),
        adjustment: "split+dividend",
        requestStart: request.startSession,
        requestEnd: request.endSession,
      }),
    };
  };
}

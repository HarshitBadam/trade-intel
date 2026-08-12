import type { RangeBarRequest } from "./provenance";
import { createProvenance } from "./provenance";
import { sessionForTimestamp } from "./range-bar-calendar";
import { chunkRangeBarRequest } from "./range-bar-coverage";
import { rangeBarProviderSymbol } from "./range-bar-routing";
import type {
  JsonResponse,
  OhlcvBar,
  RangeBarProvider,
} from "./range-bar-types";
import { finiteNumber } from "./range-bar-values";

function polygonPath(request: RangeBarRequest): string {
  const [multiplier, span] =
    request.granularity === "1Day"
      ? ["1", "day"]
      : request.granularity === "15Min"
        ? ["15", "minute"]
        : ["1", "minute"];
  const symbol = rangeBarProviderSymbol(request, "polygon");
  const params = new URLSearchParams({
    adjusted: String(request.adjusted !== false),
    sort: "asc",
    limit: "50000",
  });
  return `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${span}/${request.startSession}/${request.endSession}?${params}`;
}

export function createPolygonRangeBarProvider(
  fetcher: (url: string) => Promise<JsonResponse>,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    const rows: Array<Record<string, unknown>> = [];
    for (const chunk of chunkRangeBarRequest(request)) {
      let nextUrl: string | undefined = polygonPath(chunk);
      const visited = new Set<string>();
      while (nextUrl) {
        if (visited.has(nextUrl)) throw new Error("Polygon pagination cycle");
        visited.add(nextUrl);
        const response = await fetcher(nextUrl);
        if (!response.ok) {
          throw new Error(`Polygon bars responded with ${response.status}`);
        }
        const payload = (await response.json()) as {
          results?: Array<Record<string, unknown>>;
          next_url?: string;
        };
        if (Array.isArray(payload.results)) rows.push(...payload.results);
        nextUrl = payload.next_url;
      }
    }
    const bars = rows.flatMap((row): OhlcvBar[] => {
      const time = finiteNumber(row.t);
      const open = finiteNumber(row.o);
      const high = finiteNumber(row.h);
      const low = finiteNumber(row.l);
      const close = finiteNumber(row.c);
      const volume = finiteNumber(row.v);
      if (
        time === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        volume === null
      ) {
        return [];
      }
      const timestamp = new Date(time).toISOString();
      return [
        {
          timestamp,
          session: sessionForTimestamp(timestamp, request.calendar),
          open,
          high,
          low,
          close,
          volume,
          trades: finiteNumber(row.n) ?? undefined,
          vwap: finiteNumber(row.vw) ?? undefined,
        },
      ];
    });
    return {
      bars,
      provenance: createProvenance({
        provider: "polygon",
        fetchedAt: now(),
        sourceUrl: polygonPath(request),
        adjustment: request.adjusted === false ? "none" : "split",
        requestStart: request.startSession,
        requestEnd: request.endSession,
      }),
    };
  };
}

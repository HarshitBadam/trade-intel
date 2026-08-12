import {
  createProvenance,
  type MarketDataProvider,
  type RangeBarRequest,
} from "./provenance";
import { rangeCacheKey, rangeCacheTtlSeconds } from "./range-bar-cache";
import {
  exchangeSessions,
  normalizeRangeBarRequest,
} from "./range-bar-calendar";
import { intradayCoverage } from "./range-bar-coverage";
import {
  createRangeBarProvider,
  isRangeBarProviderAvailable,
} from "./range-bar-provider-factory";
import {
  rangeBarProviderSymbol,
  routeBarProviders,
} from "./range-bar-routing";
import type {
  RangeBarDependencies,
  RangeBarReason,
  RangeBarSeries,
  RangeBarStatus,
} from "./range-bar-types";
import { normalizeBars } from "./range-bar-values";

function unavailableSeries(
  request: RangeBarRequest,
  attemptedProviders: MarketDataProvider[],
  cacheKey: string,
  reason: RangeBarReason
): RangeBarSeries {
  const expectedSessions = exchangeSessions(
    request.startSession,
    request.endSession,
    request.calendar
  );
  return {
    ticker: request.ticker,
    instrumentSymbol: request.instrumentSymbol ?? request.ticker,
    venue: request.venue,
    calendar: request.calendar,
    granularity: request.granularity,
    adjusted: request.adjusted !== false,
    requestStart: request.startSession,
    requestEnd: request.endSession,
    bars: [],
    status: "unavailable",
    reason,
    expectedSessions,
    missingSessions: expectedSessions,
    ...intradayCoverage(request, []),
    attemptedProviders,
    cacheKey,
  };
}

function partialScore(series: RangeBarSeries): number {
  return (
    series.missingSessions.length +
    (series.missingBars ?? 0) +
    (series.reason === "adjustment_unavailable" ? 1_000_000 : 0)
  );
}

export async function getBarsForRange(
  input: RangeBarRequest,
  dependencies: RangeBarDependencies = {}
): Promise<RangeBarSeries> {
  const request = normalizeRangeBarRequest(input);
  const cacheKey = rangeCacheKey(request);
  const cached = await dependencies.cache?.get(cacheKey);
  if (cached) return cached;

  const now = dependencies.now ?? (() => new Date());
  const attemptedProviders: MarketDataProvider[] = [];
  let lastReason: RangeBarReason = "no_data";
  let bestPartial: RangeBarSeries | undefined;
  for (const provider of routeBarProviders(request)) {
    if (!isRangeBarProviderAvailable(provider, dependencies)) continue;
    attemptedProviders.push(provider);
    try {
      const result = await createRangeBarProvider(
        provider,
        dependencies,
        now
      )(request);
      const bars = normalizeBars(result.bars, request);
      if (bars.length === 0) {
        lastReason = result.reason ?? "no_data";
        continue;
      }
      const expectedSessions = exchangeSessions(
        request.startSession,
        request.endSession,
        request.calendar
      );
      const actualSessions = new Set(bars.map((bar) => bar.session));
      const missingSessions = expectedSessions.filter(
        (session) => !actualSessions.has(session)
      );
      const coverage = intradayCoverage(request, bars);
      const missingBars = coverage.missingBars ?? 0;
      const status: RangeBarStatus =
        missingSessions.length === 0 &&
        missingBars === 0 &&
        !result.partial
          ? "complete"
          : "partial";
      const provenance = result.provenance
        ? {
            ...result.provenance,
            requestStart: request.startSession,
            requestEnd: request.endSession,
            coverageStart: bars[0]?.session,
            coverageEnd: bars.at(-1)?.session,
          }
        : createProvenance({
            provider,
            fetchedAt: now(),
            requestStart: request.startSession,
            requestEnd: request.endSession,
            coverageStart: bars[0]?.session,
            coverageEnd: bars.at(-1)?.session,
          });
      const series: RangeBarSeries = {
        ticker: request.ticker,
        instrumentSymbol: rangeBarProviderSymbol(request, provider),
        venue: request.venue,
        calendar: request.calendar,
        granularity: request.granularity,
        adjusted: request.adjusted !== false,
        requestStart: request.startSession,
        requestEnd: request.endSession,
        bars,
        status,
        reason:
          status === "partial"
            ? result.reason ??
              (missingBars > 0 ? "missing_bars" : "missing_sessions")
            : undefined,
        expectedSessions,
        missingSessions,
        ...coverage,
        provenance,
        attemptedProviders: [...attemptedProviders],
        cacheKey,
      };
      if (series.status === "complete") {
        await dependencies.cache?.set(
          cacheKey,
          series,
          rangeCacheTtlSeconds(request, now())
        );
        return series;
      }
      if (!bestPartial || partialScore(series) < partialScore(bestPartial)) {
        bestPartial = series;
      }
    } catch {
      lastReason = "provider_error";
    }
  }
  if (bestPartial) {
    const result = {
      ...bestPartial,
      attemptedProviders: [...attemptedProviders],
    };
    await dependencies.cache?.set(
      cacheKey,
      result,
      rangeCacheTtlSeconds(request, now())
    );
    return result;
  }
  return unavailableSeries(request, attemptedProviders, cacheKey, lastReason);
}

export async function getMultiBarsForRange(
  requests: readonly RangeBarRequest[],
  dependencies: RangeBarDependencies = {}
): Promise<Record<string, RangeBarSeries>> {
  const results = await Promise.all(
    requests.map((request) => getBarsForRange(request, dependencies))
  );
  const output: Record<string, RangeBarSeries> = {};
  for (const result of results) {
    const key =
      output[result.ticker] === undefined
        ? result.ticker
        : `${result.ticker}:${result.instrumentSymbol}`;
    output[key] = result;
  }
  return output;
}

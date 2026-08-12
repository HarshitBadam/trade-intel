import type { RangeBarRequest } from "./provenance";
import {
  exchangeToday,
  normalizeRangeBarRequest,
} from "./range-bar-calendar";
import type { RangeBarCache, RangeBarSeries } from "./range-bar-types";

export function rangeCacheKey(input: RangeBarRequest): string {
  const request = normalizeRangeBarRequest(input);
  const symbol = request.instrumentSymbol ?? request.ticker;
  return [
    "range-bars",
    "v1",
    request.venue,
    request.calendar,
    encodeURIComponent(symbol),
    request.granularity,
    request.startSession,
    request.endSession,
    request.adjusted === false ? "raw" : "adj",
  ].join(":");
}

export function rangeCacheTtlSeconds(
  input: RangeBarRequest,
  now: Date = new Date()
): number {
  const request = normalizeRangeBarRequest(input);
  if (request.endSession < exchangeToday(now, request.calendar)) {
    return request.granularity === "1Day" ? 86_400 : 3_600;
  }
  return request.granularity === "1Min" ? 120 : 300;
}

export function rangeCacheTtlMs(
  input: RangeBarRequest,
  now: Date = new Date()
): number {
  return rangeCacheTtlSeconds(input, now) * 1_000;
}

export class InMemoryRangeBarCache implements RangeBarCache {
  private readonly values = new Map<
    string,
    { expiresAt: number; value: RangeBarSeries }
  >();

  constructor(
    private readonly maxEntries = 100,
    private readonly clock: () => number = Date.now
  ) {}

  get(key: string): RangeBarSeries | null {
    const item = this.values.get(key);
    if (!item) return null;
    if (item.expiresAt <= this.clock()) {
      this.values.delete(key);
      return null;
    }
    this.values.delete(key);
    this.values.set(key, item);
    return structuredClone(item.value);
  }

  set(key: string, value: RangeBarSeries, ttlSeconds: number): void {
    this.values.delete(key);
    this.values.set(key, {
      expiresAt: this.clock() + Math.max(0, ttlSeconds) * 1_000,
      value: structuredClone(value),
    });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) break;
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

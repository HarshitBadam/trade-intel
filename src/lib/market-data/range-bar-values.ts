import type { AlpacaBar } from "./alpaca";
import type { ExchangeCalendar, RangeBarRequest } from "./provenance";
import {
  RANGE_BAR_DATE_PATTERN,
  sessionForTimestamp,
} from "./range-bar-calendar";
import type { OhlcvBar } from "./range-bar-types";

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function objectValue(
  value: unknown
): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function validBar(bar: OhlcvBar): boolean {
  return (
    !Number.isNaN(Date.parse(bar.timestamp)) &&
    RANGE_BAR_DATE_PATTERN.test(bar.session) &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    bar.open >= 0 &&
    bar.high >= 0 &&
    bar.low >= 0 &&
    bar.close >= 0 &&
    bar.volume >= 0
  );
}

export function normalizeBars(
  bars: readonly OhlcvBar[],
  request: RangeBarRequest
): OhlcvBar[] {
  const byTime = new Map<string, OhlcvBar>();
  for (const input of bars) {
    const timestamp = new Date(input.timestamp).toISOString();
    const bar = {
      ...input,
      timestamp,
      session:
        RANGE_BAR_DATE_PATTERN.test(input.session) && input.session
          ? input.session
          : sessionForTimestamp(timestamp, request.calendar),
    };
    if (
      validBar(bar) &&
      bar.session >= request.startSession &&
      bar.session <= request.endSession
    ) {
      byTime.set(timestamp, bar);
    }
  }
  return [...byTime.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
}

export function alpacaBarToOhlcv(
  bar: AlpacaBar,
  calendar: ExchangeCalendar
): OhlcvBar {
  const timestamp = new Date(bar.t).toISOString();
  return {
    timestamp,
    session: sessionForTimestamp(timestamp, calendar),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
    trades: bar.n,
    vwap: bar.vw,
  };
}

import {
  addDays,
  exchangeSessions as listExchangeSessions,
  marketTimeZone,
  sessionDateAt,
} from "@/lib/market-calendar";
import type { ExchangeCalendar, RangeBarRequest } from "../provenance";

export const RANGE_BAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertSessionDate(value: string, name: string): void {
  if (!RANGE_BAR_DATE_PATTERN.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a valid calendar date`);
  }
}

export function normalizeRangeBarRequest(
  request: RangeBarRequest
): RangeBarRequest {
  const ticker = request.ticker.trim().toUpperCase();
  const instrumentSymbol = request.instrumentSymbol?.trim().toUpperCase();
  if (!ticker) throw new Error("ticker is required");
  assertSessionDate(request.startSession, "startSession");
  assertSessionDate(request.endSession, "endSession");
  if (request.startSession > request.endSession) {
    throw new Error("startSession must be on or before endSession");
  }
  return {
    ...request,
    ticker,
    instrumentSymbol,
    adjusted: request.adjusted !== false,
  };
}

function partsInZone(at: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
}

export function zonedDateTimeMs(
  session: string,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const [year, month, day] = session.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = partsInZone(new Date(guess), timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    guess += target - represented;
  }
  return guess;
}

export function shiftSession(session: string, days: number): string {
  return addDays(session, days);
}

export function calendarZone(calendar: ExchangeCalendar): string {
  return marketTimeZone(calendar);
}

export function sessionRangeToBounds(
  request: Pick<
    RangeBarRequest,
    "startSession" | "endSession" | "granularity" | "calendar"
  >
): { fromMs: number; toMs: number; fromISO: string; toISO: string } {
  assertSessionDate(request.startSession, "startSession");
  assertSessionDate(request.endSession, "endSession");
  if (request.startSession > request.endSession) {
    throw new Error("startSession must be on or before endSession");
  }
  const zone = calendarZone(request.calendar);
  const isDaily = request.granularity === "1Day";
  const openHour = request.calendar === "AU" ? 10 : 9;
  const openMinute = request.calendar === "AU" ? 0 : 30;
  const fromMs = zonedDateTimeMs(
    request.startSession,
    isDaily ? 0 : openHour,
    isDaily ? 0 : openMinute,
    zone
  );
  const toMs = isDaily
    ? zonedDateTimeMs(shiftSession(request.endSession, 1), 0, 0, zone)
    : zonedDateTimeMs(
        request.endSession,
        16,
        request.granularity === "15Min" ? 15 : 1,
        zone
      );
  return {
    fromMs,
    toMs,
    fromISO: new Date(fromMs).toISOString(),
    toISO: new Date(toMs).toISOString(),
  };
}

export function exchangeSessions(
  startSession: string,
  endSession: string,
  calendar: ExchangeCalendar
): string[] {
  assertSessionDate(startSession, "startSession");
  assertSessionDate(endSession, "endSession");
  if (startSession > endSession) {
    throw new Error("startSession must be on or before endSession");
  }
  return listExchangeSessions(startSession, endSession, calendar);
}

export function exchangeToday(
  now: Date,
  calendar: ExchangeCalendar
): string {
  return sessionDateAt(now, calendar);
}

export function sessionForTimestamp(
  timestamp: string,
  calendar: ExchangeCalendar
): string {
  return sessionDateAt(timestamp, calendar);
}

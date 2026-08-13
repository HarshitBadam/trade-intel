import type {
  BarGranularity,
  ExchangeCalendar,
  RangeBarRequest,
} from "../provenance";
import {
  calendarZone,
  exchangeSessions,
  normalizeRangeBarRequest,
  zonedDateTimeMs,
} from "./range-bar-calendar";
import type {
  IntradaySessionCoverage,
  OhlcvBar,
} from "./range-bar-types";

const INTRADAY_CHUNK_SESSIONS = 5;

export function chunkRangeBarRequest(
  input: RangeBarRequest,
  maxSessions = INTRADAY_CHUNK_SESSIONS
): RangeBarRequest[] {
  const request = normalizeRangeBarRequest(input);
  if (request.granularity === "1Day") return [request];
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error("maxSessions must be a positive integer");
  }
  const sessions = exchangeSessions(
    request.startSession,
    request.endSession,
    request.calendar
  );
  const chunks: RangeBarRequest[] = [];
  for (let index = 0; index < sessions.length; index += maxSessions) {
    const slice = sessions.slice(index, index + maxSessions);
    chunks.push({
      ...request,
      startSession: slice[0],
      endSession: slice[slice.length - 1],
    });
  }
  return chunks;
}

function intradayIntervalMinutes(
  granularity: BarGranularity
): number | null {
  return granularity === "1Min" ? 1 : granularity === "15Min" ? 15 : null;
}

function regularSessionSlotTimes(
  session: string,
  calendar: ExchangeCalendar,
  granularity: BarGranularity
): number[] {
  const intervalMinutes = intradayIntervalMinutes(granularity);
  if (!intervalMinutes) return [];
  const openHour = calendar === "AU" ? 10 : 9;
  const openMinute = calendar === "AU" ? 0 : 30;
  const regularMinutes = calendar === "AU" ? 360 : 390;
  const open = zonedDateTimeMs(
    session,
    openHour,
    openMinute,
    calendarZone(calendar)
  );
  const slots: number[] = [];
  for (let minute = 0; minute < regularMinutes; minute += intervalMinutes) {
    slots.push(open + minute * 60_000);
  }
  return slots;
}

export function expectedRegularSessionBarCount(
  calendar: ExchangeCalendar,
  granularity: BarGranularity
): number | null {
  const intervalMinutes = intradayIntervalMinutes(granularity);
  if (!intervalMinutes) return null;
  return (calendar === "AU" ? 360 : 390) / intervalMinutes;
}

export function intradayCoverage(
  request: RangeBarRequest,
  bars: readonly OhlcvBar[]
): {
  expectedBars?: number;
  missingBars?: number;
  sessionCoverage?: IntradaySessionCoverage[];
} {
  if (request.granularity === "1Day") return {};
  const actualTimes = new Set(bars.map((bar) => Date.parse(bar.timestamp)));
  const sessionCoverage = exchangeSessions(
    request.startSession,
    request.endSession,
    request.calendar
  ).map((session): IntradaySessionCoverage => {
    const slots = regularSessionSlotTimes(
      session,
      request.calendar,
      request.granularity
    );
    const coveredBars = slots.reduce(
      (count, timestamp) => count + Number(actualTimes.has(timestamp)),
      0
    );
    return {
      session,
      expectedBars: slots.length,
      coveredBars,
      missingBars: slots.length - coveredBars,
      complete: coveredBars === slots.length,
    };
  });
  return {
    expectedBars: sessionCoverage.reduce(
      (total, coverage) => total + coverage.expectedBars,
      0
    ),
    missingBars: sessionCoverage.reduce(
      (total, coverage) => total + coverage.missingBars,
      0
    ),
    sessionCoverage,
  };
}

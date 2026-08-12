import {
  addDays,
  currentSession,
  previousSession,
  sessionOnOrAfter,
  sessionOnOrBefore,
} from "./temporal-calendar";
import type {
  IntervalKind,
  MarketCalendar,
  TemporalInterval,
} from "./temporal-types";

export function createInterval(
  args: Omit<TemporalInterval, "version">
): TemporalInterval {
  return { version: 1, ...args };
}

function toUtcDate(session: string): Date {
  return new Date(`${session}T00:00:00.000Z`);
}

function toSession(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(session: string): string {
  return `${session.slice(0, 7)}-01`;
}

function yearStart(session: string): string {
  return `${session.slice(0, 4)}-01-01`;
}

function shiftMonths(session: string, months: number): string {
  const date = toUtcDate(session);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return toSession(date);
}

function weekStart(session: string): string {
  const day = toUtcDate(session).getUTCDay();
  return addDays(session, day === 0 ? -6 : 1 - day);
}

type LabelBuilder = (
  calendar: MarketCalendar,
  end: string
) => { kind: IntervalKind; start: string; end: string };

export const LABEL_BUILDERS: Record<string, LabelBuilder> = {
  today: (_calendar, end) => ({ kind: "session", start: end, end }),
  yesterday: (calendar, end) => {
    const prior = previousSession(end, calendar);
    return { kind: "prior_session", start: prior, end: prior };
  },
  "last few days": (calendar, end) => ({
    kind: "trailing",
    start: sessionOnOrAfter(addDays(end, -4), calendar),
    end,
  }),
  "this week": (calendar, end) => ({
    kind: "to_date",
    start: sessionOnOrAfter(weekStart(end), calendar),
    end,
  }),
  "last week": (calendar, end) => {
    const priorMonday = addDays(weekStart(end), -7);
    return {
      kind: "range",
      start: sessionOnOrAfter(priorMonday, calendar),
      end: sessionOnOrBefore(addDays(priorMonday, 6), calendar),
    };
  },
  "month to date": (calendar, end) => ({
    kind: "to_date",
    start: sessionOnOrAfter(monthStart(end), calendar),
    end,
  }),
  "trailing month": (calendar, end) => ({
    kind: "trailing",
    start: sessionOnOrBefore(shiftMonths(end, -1), calendar),
    end,
  }),
  "last month": (calendar, end) => {
    const previousMonthEnd = addDays(monthStart(end), -1);
    return {
      kind: "range",
      start: sessionOnOrAfter(monthStart(previousMonthEnd), calendar),
      end: sessionOnOrBefore(previousMonthEnd, calendar),
    };
  },
  "this quarter": (calendar, end) => {
    const month = Number(end.slice(5, 7));
    const quarterMonth = month - ((month - 1) % 3);
    const start = `${end.slice(0, 4)}-${String(quarterMonth).padStart(2, "0")}-01`;
    return { kind: "to_date", start: sessionOnOrAfter(start, calendar), end };
  },
  "last quarter": (calendar, end) => ({
    kind: "trailing",
    start: sessionOnOrBefore(shiftMonths(end, -3), calendar),
    end,
  }),
  "this year": (calendar, end) => ({
    kind: "to_date",
    start: sessionOnOrAfter(yearStart(end), calendar),
    end,
  }),
  "last year": (calendar, end) => ({
    kind: "trailing",
    start: sessionOnOrBefore(shiftMonths(end, -12), calendar),
    end,
  }),
};

export function offsetStart(
  end: string,
  count: number,
  unit: string
): string {
  if (/^years?/i.test(unit)) return shiftMonths(end, -12 * count);
  if (/^months?/i.test(unit)) return shiftMonths(end, -count);
  if (/^weeks?/i.test(unit)) return addDays(end, -7 * count);
  return addDays(end, -count);
}

export function defaultInterval(
  calendar: MarketCalendar,
  now = new Date()
): TemporalInterval {
  const end = currentSession(calendar, now);
  return createInterval({
    label: "today",
    kind: "session",
    calendar,
    startSession: end,
    endSession: end,
    source: "default",
  });
}

export function translateInterval(
  source: TemporalInterval,
  calendar: MarketCalendar,
  now = new Date()
): TemporalInterval {
  if (source.calendar === calendar) return source;
  const builder = LABEL_BUILDERS[source.label];
  const end = currentSession(calendar, now);
  if (!builder) {
    return {
      ...source,
      calendar,
      startSession: sessionOnOrAfter(source.startSession, calendar),
      endSession: sessionOnOrBefore(source.endSession, calendar),
    };
  }
  const built = builder(calendar, end);
  return createInterval({
    label: source.label,
    kind: built.kind,
    calendar,
    startSession: built.start,
    endSession: built.end,
    source: source.source,
    raw: source.raw,
  });
}

export function describeInterval(value: TemporalInterval): string {
  const venue = value.calendar === "AU" ? "ASX" : "US";
  return value.startSession === value.endSession
    ? `${value.label} (${venue} session ${value.endSession})`
    : `${value.label} (${venue} sessions ${value.startSession} to ${value.endSession})`;
}

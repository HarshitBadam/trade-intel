export type MarketCalendar = "US" | "AU";

export type IntervalKind =
  | "session"
  | "prior_session"
  | "to_date"
  | "trailing"
  | "range";

export type IntervalSource = "explicit" | "inherited" | "default";

export type TemporalInterval = {
  version: 1;
  label: string;
  kind: IntervalKind;
  calendar: MarketCalendar;
  startSession: string;
  endSession: string;
  source: IntervalSource;
  raw?: string;
};

export type TemporalResolution =
  | { status: "none"; intervals: [] }
  | { status: "resolved"; intervals: TemporalInterval[] }
  | {
      status: "invalid";
      intervals: [];
      reason: "invalid_date";
      raw: string;
      clarification: string;
    };

const TIME_ZONES: Record<MarketCalendar, string> = {
  US: "America/New_York",
  AU: "Australia/Sydney",
};

const SESSION_OPEN_MINUTES: Record<MarketCalendar, number> = {
  US: 9 * 60 + 30,
  AU: 10 * 60,
};

const SESSION_CLOSE_MINUTES: Record<MarketCalendar, number> = {
  US: 16 * 60,
  AU: 16 * 60,
};

type ZonedNow = { date: string; minutes: number };

function zonedNow(now: Date, calendar: MarketCalendar): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONES[calendar],
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const hour = Number(value("hour")) % 24;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: hour * 60 + Number(value("minute")),
  };
}

function toUtcDate(session: string): Date {
  return new Date(`${session}T00:00:00.000Z`);
}

function toSession(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function marketTimeZone(calendar: MarketCalendar): string {
  return TIME_ZONES[calendar];
}

export function sessionDateAt(
  value: Date | string,
  calendar: MarketCalendar
): string {
  return zonedNow(
    typeof value === "string" ? new Date(value) : value,
    calendar
  ).date;
}

export function addDays(session: string, days: number): string {
  const date = toUtcDate(session);
  date.setUTCDate(date.getUTCDate() + days);
  return toSession(date);
}

function dayOfWeek(session: string): number {
  return toUtcDate(session).getUTCDay();
}

function nthWeekdayOf(
  year: number,
  month: number,
  weekday: number,
  nth: number
): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toSession(
    new Date(Date.UTC(year, month - 1, 1 + offset + (nth - 1) * 7))
  );
}

function lastWeekdayOf(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return toSession(
    new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset))
  );
}

function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toSession(new Date(Date.UTC(year, month - 1, day)));
}

function usObserved(session: string): string {
  const day = dayOfWeek(session);
  if (day === 6) return addDays(session, -1);
  if (day === 0) return addDays(session, 1);
  return session;
}

function nextUnoccupiedWeekday(
  session: string,
  occupied: ReadonlySet<string>
): string {
  let candidate = session;
  do {
    candidate = addDays(candidate, 1);
    const day = dayOfWeek(candidate);
    if (day !== 0 && day !== 6 && !occupied.has(candidate)) return candidate;
  } while (true);
}

function addAustralianHoliday(
  holidays: Set<string>,
  session: string
): void {
  const day = dayOfWeek(session);
  holidays.add(
    day === 0 || day === 6
      ? nextUnoccupiedWeekday(session, holidays)
      : session
  );
}

const holidayCache = new Map<string, Set<string>>();

function holidays(calendar: MarketCalendar, year: number): Set<string> {
  const key = `${calendar}:${year}`;
  const cached = holidayCache.get(key);
  if (cached) return cached;

  const easter = easterSunday(year);
  const dates = new Set<string>([addDays(easter, -2)]);
  if (calendar === "US") {
    dates.add(usObserved(`${year}-01-01`));
    dates.add(usObserved(`${year + 1}-01-01`));
    dates.add(nthWeekdayOf(year, 1, 1, 3));
    dates.add(nthWeekdayOf(year, 2, 1, 3));
    dates.add(lastWeekdayOf(year, 5, 1));
    if (year >= 2022) dates.add(usObserved(`${year}-06-19`));
    dates.add(usObserved(`${year}-07-04`));
    dates.add(nthWeekdayOf(year, 9, 1, 1));
    dates.add(nthWeekdayOf(year, 11, 4, 4));
    dates.add(usObserved(`${year}-12-25`));
  } else {
    addAustralianHoliday(dates, `${year}-01-01`);
    addAustralianHoliday(dates, `${year}-01-26`);
    dates.add(addDays(easter, 1));
    dates.add(`${year}-04-25`);
    dates.add(nthWeekdayOf(year, 6, 1, 2));
    dates.add(nthWeekdayOf(year, 10, 1, 1));
    addAustralianHoliday(dates, `${year}-12-25`);
    addAustralianHoliday(dates, `${year}-12-26`);
  }

  holidayCache.set(key, dates);
  return dates;
}

export function isTradingSession(
  session: string,
  calendar: MarketCalendar
): boolean {
  const day = dayOfWeek(session);
  if (day === 0 || day === 6) return false;
  return !holidays(calendar, Number(session.slice(0, 4))).has(session);
}

export function exchangeSessions(
  startSession: string,
  endSession: string,
  calendar: MarketCalendar
): string[] {
  const sessions: string[] = [];
  for (
    let session = startSession;
    session <= endSession;
    session = addDays(session, 1)
  ) {
    if (isTradingSession(session, calendar)) sessions.push(session);
  }
  return sessions;
}

export function previousSession(
  session: string,
  calendar: MarketCalendar
): string {
  let candidate = addDays(session, -1);
  for (let guard = 0; guard < 15; guard += 1) {
    if (isTradingSession(candidate, calendar)) return candidate;
    candidate = addDays(candidate, -1);
  }
  return candidate;
}

export function sessionOnOrBefore(
  session: string,
  calendar: MarketCalendar
): string {
  let candidate = session;
  for (let guard = 0; guard < 15; guard += 1) {
    if (isTradingSession(candidate, calendar)) return candidate;
    candidate = addDays(candidate, -1);
  }
  return candidate;
}

export function sessionOnOrAfter(
  session: string,
  calendar: MarketCalendar
): string {
  let candidate = session;
  for (let guard = 0; guard < 15; guard += 1) {
    if (isTradingSession(candidate, calendar)) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

export function currentSession(
  calendar: MarketCalendar,
  now = new Date()
): string {
  const local = zonedNow(now, calendar);
  if (
    isTradingSession(local.date, calendar) &&
    local.minutes >= SESSION_OPEN_MINUTES[calendar]
  ) {
    return local.date;
  }
  return sessionOnOrBefore(addDays(local.date, -1), calendar);
}

export function latestCompletedSession(
  calendar: MarketCalendar,
  now = new Date()
): string {
  const local = zonedNow(now, calendar);
  if (
    isTradingSession(local.date, calendar) &&
    local.minutes >= SESSION_CLOSE_MINUTES[calendar]
  ) {
    return local.date;
  }
  return sessionOnOrBefore(addDays(local.date, -1), calendar);
}

export function temporalIntervalKey(
  value: Pick<TemporalInterval, "calendar" | "startSession" | "endSession">
): string {
  return `${value.calendar}:${value.startSession}:${value.endSession}`;
}

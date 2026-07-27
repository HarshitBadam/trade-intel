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
  /** Stable label used in prompts, evidence plans and answer copy. */
  label: string;
  kind: IntervalKind;
  calendar: MarketCalendar;
  /** Exchange-local trading sessions, inclusive, as YYYY-MM-DD. */
  startSession: string;
  endSession: string;
  source: IntervalSource;
  /** The user text this interval was parsed from, when explicit. */
  raw?: string;
};

const TIME_ZONES: Record<MarketCalendar, string> = {
  US: "America/New_York",
  AU: "Australia/Sydney",
};

/** Local open time in minutes from midnight; a session is "started" after it. */
const SESSION_OPEN_MINUTES: Record<MarketCalendar, number> = {
  US: 9 * 60 + 30,
  AU: 10 * 60,
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
  // Intl renders midnight as hour 24 in some ICU versions.
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

/** Anonymous Gregorian computus; both calendars close for Good Friday. */
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

/** Weekend holidays roll to the nearest weekday, US-market style. */
function usObserved(session: string): string {
  const day = dayOfWeek(session);
  if (day === 6) return addDays(session, -1);
  if (day === 0) return addDays(session, 1);
  return session;
}

/** ASX rolls a weekend holiday forward, never back into the prior week. */
function auObserved(session: string): string {
  const day = dayOfWeek(session);
  if (day === 6) return addDays(session, 2);
  if (day === 0) return addDays(session, 1);
  return session;
}

const holidayCache = new Map<string, Set<string>>();

function holidays(calendar: MarketCalendar, year: number): Set<string> {
  const key = `${calendar}:${year}`;
  const cached = holidayCache.get(key);
  if (cached) return cached;
  const easter = easterSunday(year);
  const goodFriday = addDays(easter, -2);
  const dates =
    calendar === "US"
      ? [
          usObserved(`${year}-01-01`),
          nthWeekdayOf(year, 1, 1, 3), // Martin Luther King Jr. Day
          nthWeekdayOf(year, 2, 1, 3), // Washington's Birthday
          goodFriday,
          lastWeekdayOf(year, 5, 1), // Memorial Day
          usObserved(`${year}-06-19`), // Juneteenth
          usObserved(`${year}-07-04`),
          nthWeekdayOf(year, 9, 1, 1), // Labor Day
          nthWeekdayOf(year, 11, 4, 4), // Thanksgiving
          usObserved(`${year}-12-25`),
        ]
      : [
          auObserved(`${year}-01-01`),
          auObserved(`${year}-01-26`), // Australia Day
          goodFriday,
          addDays(easter, 1), // Easter Monday
          `${year}-04-25`, // ANZAC Day; the ASX does not roll it forward
          nthWeekdayOf(year, 6, 1, 2), // King's Birthday
          auObserved(`${year}-12-25`),
          auObserved(`${year}-12-26`), // Boxing Day
        ];
  const set = new Set(dates);
  holidayCache.set(key, set);
  return set;
}

export function isTradingSession(
  session: string,
  calendar: MarketCalendar
): boolean {
  const day = dayOfWeek(session);
  if (day === 0 || day === 6) return false;
  return !holidays(calendar, Number(session.slice(0, 4))).has(session);
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

function sessionOnOrBefore(session: string, calendar: MarketCalendar): string {
  let candidate = session;
  for (let guard = 0; guard < 15; guard += 1) {
    if (isTradingSession(candidate, calendar)) return candidate;
    candidate = addDays(candidate, -1);
  }
  return candidate;
}

function sessionOnOrAfter(session: string, calendar: MarketCalendar): string {
  let candidate = session;
  for (let guard = 0; guard < 15; guard += 1) {
    if (isTradingSession(candidate, calendar)) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/**
 * The session a user means by "today": the current one once it has opened,
 * otherwise the last completed session. Pre-open on a trading day still refers
 * to the previous close, which is what every provider can actually supply.
 */
export function currentSession(calendar: MarketCalendar, now = new Date()): string {
  const local = zonedNow(now, calendar);
  if (
    isTradingSession(local.date, calendar) &&
    local.minutes >= SESSION_OPEN_MINUTES[calendar]
  ) {
    return local.date;
  }
  return sessionOnOrBefore(addDays(local.date, -1), calendar);
}

function interval(args: {
  label: string;
  kind: IntervalKind;
  calendar: MarketCalendar;
  startSession: string;
  endSession: string;
  source: IntervalSource;
  raw?: string;
}): TemporalInterval {
  return { version: 1, ...args };
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

/** Monday of the ISO week containing the session. */
function weekStart(session: string): string {
  const day = dayOfWeek(session);
  return addDays(session, day === 0 ? -6 : 1 - day);
}

type LabelBuilder = (
  calendar: MarketCalendar,
  end: string,
  now: Date
) => { kind: IntervalKind; start: string; end: string };

const LABEL_BUILDERS: Record<string, LabelBuilder> = {
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

const EXPLICIT_PATTERNS: [RegExp, string][] = [
  [/\btoday\b|\bright now\b|\bcurrently\b/i, "today"],
  [/\byesterday\b/i, "yesterday"],
  [
    /\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\s+(?:ago|back)\b|\bthe other day\b|\blast few days\b|\brecently\b|\blately\b/i,
    "last few days",
  ],
  [/\bthis week\b|\bthis week ?end\b/i, "this week"],
  [/\blast week\b|\bover the last week\b|\bpast week\b/i, "last week"],
  [
    /\bmonth[- ]to[- ]date\b|\bmtd\b|\bthis month\b|\bmonth so far\b|\bsince (?:the )?start of (?:the )?month\b/i,
    "month to date",
  ],
  [/\btrailing month\b|\bover the (?:last|past) month\b/i, "trailing month"],
  [/\blast month\b/i, "last month"],
  [/\bthis quarter\b/i, "this quarter"],
  [/\blast quarter\b|\bover the (?:last|past) quarter\b/i, "last quarter"],
  [/\byear[- ]to[- ]date\b|\bytd\b|\bthis year\b/i, "this year"],
  [/\blast year\b|\bover the (?:last|past) year\b/i, "last year"],
];

const RELATIVE_SPAN =
  /\b(?:past|last|over the last|over the past)\s+(\d{1,3})\s+(days?|weeks?|months?|years?)\b/i;
const EXPLICIT_RANGE =
  /\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/i;
const SINGLE_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

function spanDays(count: number, unit: string): number {
  if (/^week/i.test(unit)) return count * 7;
  if (/^month/i.test(unit)) return count * 30;
  if (/^year/i.test(unit)) return count * 365;
  return count;
}

/**
 * Parses every temporal reference in a message against one market calendar.
 * Parsing lives here so planning, prompting and state all read the same
 * intervals rather than each re-interpreting the raw text.
 */
export function parseIntervals(args: {
  message: string;
  calendar: MarketCalendar;
  now?: Date;
}): TemporalInterval[] {
  const now = args.now ?? new Date();
  const end = currentSession(args.calendar, now);
  const found: { index: number; interval: TemporalInterval }[] = [];

  for (const [pattern, label] of EXPLICIT_PATTERNS) {
    const match = pattern.exec(args.message);
    if (match?.index === undefined) continue;
    const built = LABEL_BUILDERS[label](args.calendar, end, now);
    found.push({
      index: match.index,
      interval: interval({
        label,
        kind: built.kind,
        calendar: args.calendar,
        startSession: built.start,
        endSession: built.end,
        source: "explicit",
        raw: match[0].toLowerCase(),
      }),
    });
  }

  const range = EXPLICIT_RANGE.exec(args.message);
  if (range?.index !== undefined) {
    found.push({
      index: range.index,
      interval: interval({
        label: `${range[1]} to ${range[2]}`,
        kind: "range",
        calendar: args.calendar,
        startSession: sessionOnOrAfter(range[1], args.calendar),
        endSession: sessionOnOrBefore(range[2], args.calendar),
        source: "explicit",
        raw: range[0].toLowerCase(),
      }),
    });
  } else {
    const span = RELATIVE_SPAN.exec(args.message);
    if (span?.index !== undefined) {
      const days = spanDays(Number(span[1]), span[2]);
      found.push({
        index: span.index,
        interval: interval({
          label: `past ${span[1]} ${span[2].toLowerCase()}`,
          kind: "trailing",
          calendar: args.calendar,
          startSession: sessionOnOrBefore(addDays(end, -days), args.calendar),
          endSession: end,
          source: "explicit",
          raw: span[0].toLowerCase(),
        }),
      });
    } else {
      const single = SINGLE_DATE.exec(args.message);
      if (single?.index !== undefined && found.length === 0) {
        const session = sessionOnOrBefore(single[1], args.calendar);
        found.push({
          index: single.index,
          interval: interval({
            label: single[1],
            kind: "session",
            calendar: args.calendar,
            startSession: session,
            endSession: session,
            source: "explicit",
            raw: single[0],
          }),
        });
      }
    }
  }

  const seen = new Set<string>();
  return found
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.interval)
    .filter((candidate) => {
      if (seen.has(candidate.label)) return false;
      seen.add(candidate.label);
      return true;
    });
}

export function defaultInterval(
  calendar: MarketCalendar,
  now = new Date()
): TemporalInterval {
  const end = currentSession(calendar, now);
  return interval({
    label: "today",
    kind: "session",
    calendar,
    startSession: end,
    endSession: end,
    source: "default",
  });
}

/** Re-anchors an interval onto another exchange calendar for comparisons. */
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
  const built = builder(calendar, end, now);
  return interval({
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

/** Legacy wire format; conversation state keeps this until clients migrate. */
export function intervalsToHorizon(
  intervals: TemporalInterval[]
): string | undefined {
  return intervals.length > 0
    ? intervals.map((value) => value.label).join(" vs ")
    : undefined;
}

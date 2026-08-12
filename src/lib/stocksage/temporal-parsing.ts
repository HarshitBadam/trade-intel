import {
  currentSession,
  sessionOnOrAfter,
  sessionOnOrBefore,
} from "./temporal-calendar";
import {
  createInterval,
  LABEL_BUILDERS,
  offsetStart,
} from "./temporal-intervals";
import {
  temporalIntervalKey,
  type MarketCalendar,
  type TemporalInterval,
  type TemporalResolution,
} from "./temporal-types";

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
const RELATIVE_POINT =
  /\b(a|an|one|\d{1,3})\s+(days?|weeks?|months?|years?)\s+(?:ago|back)\b/i;
const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})`;
const EXPLICIT_RANGE = new RegExp(
  String.raw`\bbetween\s+(${DATE_TOKEN})\s+and\s+(${DATE_TOKEN})\b`,
  "i"
);
const SINGLE_DATE = new RegExp(String.raw`\b(${DATE_TOKEN})\b`);

type FoundInterval = {
  index: number;
  endIndex: number;
  interval: TemporalInterval;
};

function strictSessionDate(
  year: number,
  month: number,
  day: number
): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseDateToken(raw: string): string | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return strictSessionDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return slash
    ? strictSessionDate(Number(slash[3]), Number(slash[2]), Number(slash[1]))
    : null;
}

function addFound(
  found: FoundInterval[],
  match: RegExpExecArray,
  value: TemporalInterval
): boolean {
  if (match.index === undefined) return false;
  const endIndex = match.index + match[0].length;
  if (
    found.some(
      (candidate) =>
        match.index < candidate.endIndex && endIndex > candidate.index
    )
  ) {
    return false;
  }
  found.push({ index: match.index, endIndex, interval: value });
  return true;
}

function namedIntervals(
  message: string,
  calendar: MarketCalendar,
  end: string,
  found: FoundInterval[]
): void {
  for (const [pattern, label] of EXPLICIT_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.index === undefined) continue;
    const built = LABEL_BUILDERS[label](calendar, end);
    addFound(
      found,
      match,
      createInterval({
        label,
        kind: built.kind,
        calendar,
        startSession: built.start,
        endSession: built.end,
        source: "explicit",
        raw: match[0].toLowerCase(),
      })
    );
  }
}

export function resolveTemporalContext(args: {
  message: string;
  calendar: MarketCalendar;
  now?: Date;
}): TemporalResolution {
  const now = args.now ?? new Date();
  const end = currentSession(args.calendar, now);
  const found: FoundInterval[] = [];
  let invalid: { raw: string } | undefined;

  namedIntervals(args.message, args.calendar, end, found);

  const range = EXPLICIT_RANGE.exec(args.message);
  if (range?.index !== undefined) {
    const startDate = parseDateToken(range[1]);
    const endDate = parseDateToken(range[2]);
    if (!startDate || !endDate || startDate > endDate) {
      invalid = { raw: !startDate ? range[1] : !endDate ? range[2] : range[0] };
    } else {
      const startSession = sessionOnOrAfter(startDate, args.calendar);
      const endSession = sessionOnOrBefore(endDate, args.calendar);
      if (startSession > endSession) {
        invalid = { raw: range[0] };
      } else {
        addFound(
          found,
          range,
          createInterval({
            label: `${range[1]} to ${range[2]}`,
            kind: "range",
            calendar: args.calendar,
            startSession,
            endSession,
            source: "explicit",
            raw: range[0].toLowerCase(),
          })
        );
      }
    }
  }

  const span = RELATIVE_SPAN.exec(args.message);
  if (span?.index !== undefined) {
    const count = Number(span[1]);
    addFound(
      found,
      span,
      createInterval({
        label: `past ${span[1]} ${span[2].toLowerCase()}`,
        kind: "trailing",
        calendar: args.calendar,
        startSession: sessionOnOrBefore(
          offsetStart(end, count, span[2]),
          args.calendar
        ),
        endSession: end,
        source: "explicit",
        raw: span[0].toLowerCase(),
      })
    );
  }

  const point = RELATIVE_POINT.exec(args.message);
  if (point?.index !== undefined) {
    const count = /^(?:a|an|one)$/i.test(point[1]) ? 1 : Number(point[1]);
    const session = sessionOnOrBefore(
      offsetStart(end, count, point[2]),
      args.calendar
    );
    addFound(
      found,
      point,
      createInterval({
        label: point[0].toLowerCase(),
        kind: "session",
        calendar: args.calendar,
        startSession: session,
        endSession: session,
        source: "explicit",
        raw: point[0].toLowerCase(),
      })
    );
  }

  const single = SINGLE_DATE.exec(args.message);
  if (single?.index !== undefined) {
    const parsed = parseDateToken(single[1]);
    if (!parsed) {
      invalid = { raw: single[1] };
    } else {
      const session = sessionOnOrBefore(parsed, args.calendar);
      addFound(
        found,
        single,
        createInterval({
          label: single[1],
          kind: "session",
          calendar: args.calendar,
          startSession: session,
          endSession: session,
          source: "explicit",
          raw: single[0],
        })
      );
    }
  }

  if (invalid) {
    return {
      status: "invalid",
      intervals: [],
      reason: "invalid_date",
      raw: invalid.raw,
      clarification: `"${invalid.raw}" is not a valid date. Use DD/MM/YYYY or YYYY-MM-DD.`,
    };
  }

  const seen = new Set<string>();
  const intervals = found
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.interval)
    .filter((candidate) => {
      const key = `${temporalIntervalKey(candidate)}:${candidate.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return intervals.length > 0
    ? { status: "resolved", intervals }
    : { status: "none", intervals: [] };
}

export function parseIntervals(args: {
  message: string;
  calendar: MarketCalendar;
  now?: Date;
}): TemporalInterval[] {
  const result = resolveTemporalContext(args);
  return result.status === "resolved" ? result.intervals : [];
}

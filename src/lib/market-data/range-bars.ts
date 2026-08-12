import "server-only";

import { hasAlpaca, hasPolygon } from "@/lib/config";
import type { TemporalInterval } from "@/lib/stocksage/temporal";
import { getAlpacaBars, type AlpacaBar, type AlpacaTimeframe } from "./alpaca";
import { polygonFetch } from "./polygon";
import { buildChatQuote } from "./quote-metrics";
import type { ChatQuote } from "./types";
import {
  createProvenance,
  type BarGranularity,
  type DataProvenance,
  type ExchangeCalendar,
  type MarketDataProvider,
  type RangeBarRequest,
} from "./provenance";

export type { BarGranularity, ExchangeCalendar, RangeBarRequest };

export type OhlcvBar = {
  timestamp: string;
  /** Exchange-local YYYY-MM-DD session. */
  session: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
  vwap?: number;
};

export type RangeBarStatus = "complete" | "partial" | "unavailable";
export type RangeBarReason =
  | "missing_sessions"
  | "missing_bars"
  | "provider_limit"
  | "provider_error"
  | "listing_not_found"
  | "range_before_listing"
  | "adjustment_unavailable"
  | "unsupported_granularity"
  | "no_data";

export type RangeBarSeries = {
  ticker: string;
  instrumentSymbol: string;
  venue: RangeBarRequest["venue"];
  calendar: ExchangeCalendar;
  granularity: BarGranularity;
  adjusted: boolean;
  requestStart: string;
  requestEnd: string;
  bars: OhlcvBar[];
  status: RangeBarStatus;
  reason?: RangeBarReason;
  expectedSessions: string[];
  missingSessions: string[];
  /** Present for intraday requests and based on regular exchange hours. */
  expectedBars?: number;
  missingBars?: number;
  sessionCoverage?: IntradaySessionCoverage[];
  provenance?: DataProvenance;
  attemptedProviders: MarketDataProvider[];
  cacheKey: string;
};

export type IntradaySessionCoverage = {
  session: string;
  expectedBars: number;
  coveredBars: number;
  missingBars: number;
  complete: boolean;
};

export type RangeBarProviderResult = {
  bars: OhlcvBar[];
  provenance?: DataProvenance;
  partial?: boolean;
  reason?: RangeBarReason;
};

export type RangeBarProvider = (
  request: Readonly<RangeBarRequest>
) => Promise<RangeBarProviderResult>;

export interface RangeBarCache {
  get(key: string): Promise<RangeBarSeries | null> | RangeBarSeries | null;
  set(
    key: string,
    value: RangeBarSeries,
    ttlSeconds: number
  ): Promise<void> | void;
}

type JsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type TextResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type RangeBarDependencies = {
  providers?: Partial<Record<"alpaca" | "polygon" | "yahoo" | "stooq", RangeBarProvider>>;
  alpaca?: typeof getAlpacaBars;
  polygonFetch?: (url: string) => Promise<JsonResponse>;
  yahooFetch?: (url: string, init: RequestInit) => Promise<JsonResponse>;
  stooqFetch?: (url: string, init: RequestInit) => Promise<TextResponse>;
  cache?: RangeBarCache;
  now?: () => Date;
  /** Override production config gates in a fixture without changing process env. */
  availability?: Partial<Record<"alpaca" | "polygon" | "yahoo" | "stooq", boolean>>;
};

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const STOOQ_HISTORY_URL = "https://stooq.com/q/d/l/";
const FETCH_TIMEOUT_MS = 8_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const STOOQ_INDEX_SYMBOLS: Record<string, string> = {
  GSPC: "^spx",
  SPX: "^spx",
  IXIC: "^ndq",
  DJI: "^dji",
  RUT: "^rut",
};

const YAHOO_INDEX_SYMBOLS: Record<string, string> = {
  GSPC: "^GSPC",
  SPX: "^GSPC",
  IXIC: "^IXIC",
  DJI: "^DJI",
  RUT: "^RUT",
  AXJO: "^AXJO",
};

function assertSessionDate(value: string, name: string): void {
  if (!DATE_PATTERN.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid calendar date`);
  }
}

function normalizedRequest(request: RangeBarRequest): RangeBarRequest {
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

function zonedDateTimeMs(
  session: string,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const [year, month, day] = session.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  // Two iterations handle both standard/daylight offsets without a timezone
  // dependency and remain deterministic under Node's ICU implementation.
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

function shiftSession(session: string, days: number): string {
  const date = new Date(`${session}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarZone(calendar: ExchangeCalendar): string {
  return calendar === "AU" ? "Australia/Sydney" : "America/New_York";
}

/**
 * Converts inclusive exchange-local dates to provider bounds. Daily ranges
 * end at the next local midnight (exclusive); intraday ranges use regular
 * market hours and an exclusive final interval.
 */
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
    : zonedDateTimeMs(request.endSession, 16, request.granularity === "15Min" ? 15 : 1, zone);
  return {
    fromMs,
    toMs,
    fromISO: new Date(fromMs).toISOString(),
    toISO: new Date(toMs).toISOString(),
  };
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  first.setUTCDate(1 + offset + (nth - 1) * 7);
  return first.toISOString().slice(0, 10);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
  return last.toISOString().slice(0, 10);
}

function observed(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 6 ? shiftSession(date, -1) : day === 0 ? shiftSession(date, 1) : date;
}

function nextWeekday(date: string, occupied: ReadonlySet<string>): string {
  let result = date;
  do {
    result = shiftSession(result, 1);
    const weekday = new Date(`${result}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !occupied.has(result)) return result;
  } while (true);
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
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function exchangeHolidays(year: number, calendar: ExchangeCalendar): Set<string> {
  const holidays = new Set<string>();
  const easter = easterSunday(year);
  holidays.add(shiftSession(easter, -2));
  if (calendar === "US") {
    holidays.add(observed(`${year}-01-01`));
    // A Saturday New Year is observed on the preceding calendar year.
    holidays.add(observed(`${year + 1}-01-01`));
    holidays.add(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr Day
    holidays.add(nthWeekday(year, 2, 1, 3)); // Presidents Day
    holidays.add(lastWeekday(year, 5, 1)); // Memorial Day
    if (year >= 2022) holidays.add(observed(`${year}-06-19`));
    holidays.add(observed(`${year}-07-04`));
    holidays.add(nthWeekday(year, 9, 1, 1)); // Labor Day
    holidays.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
    holidays.add(observed(`${year}-12-25`));
  } else {
    const addAustralianHoliday = (value: string) => {
      const weekday = new Date(`${value}T00:00:00.000Z`).getUTCDay();
      holidays.add(
        weekday === 0 || weekday === 6 ? nextWeekday(value, holidays) : value
      );
    };
    addAustralianHoliday(`${year}-01-01`);
    addAustralianHoliday(`${year}-01-26`); // Australia Day
    holidays.add(shiftSession(easter, 1)); // Easter Monday
    // ASX has no substituted Anzac trading holiday when it falls on a weekend.
    holidays.add(`${year}-04-25`);
    holidays.add(nthWeekday(year, 6, 1, 2)); // King's Birthday (NSW)
    holidays.add(nthWeekday(year, 10, 1, 1)); // Labour Day (NSW)
    const christmas = `${year}-12-25`;
    const boxing = `${year}-12-26`;
    const christmasDay = new Date(`${christmas}T00:00:00.000Z`).getUTCDay();
    const boxingDay = new Date(`${boxing}T00:00:00.000Z`).getUTCDay();
    if (christmasDay !== 0 && christmasDay !== 6) holidays.add(christmas);
    if (boxingDay !== 0 && boxingDay !== 6) holidays.add(boxing);
    if (christmasDay === 0 || christmasDay === 6) {
      holidays.add(nextWeekday(christmas, holidays));
    }
    if (boxingDay === 0 || boxingDay === 6) {
      holidays.add(nextWeekday(boxing, holidays));
    }
  }
  return holidays;
}

export function exchangeSessions(
  startSession: string,
  endSession: string,
  calendar: ExchangeCalendar
): string[] {
  assertSessionDate(startSession, "startSession");
  assertSessionDate(endSession, "endSession");
  if (startSession > endSession) throw new Error("startSession must be on or before endSession");
  const sessions: string[] = [];
  const holidays = new Map<number, Set<string>>();
  for (let current = startSession; current <= endSession; current = shiftSession(current, 1)) {
    const date = new Date(`${current}T00:00:00.000Z`);
    const day = date.getUTCDay();
    if (day === 0 || day === 6) continue;
    const year = date.getUTCFullYear();
    let yearHolidays = holidays.get(year);
    if (!yearHolidays) {
      yearHolidays = exchangeHolidays(year, calendar);
      holidays.set(year, yearHolidays);
    }
    if (!yearHolidays.has(current)) sessions.push(current);
  }
  return sessions;
}

const INTRADAY_CHUNK_SESSIONS = 5;

/**
 * Bounds intraday provider requests without imposing a total-history window.
 * Every exchange session in the caller's range is covered by exactly one
 * chunk; daily requests retain their original arbitrary range.
 */
export function chunkRangeBarRequest(
  input: RangeBarRequest,
  maxSessions = INTRADAY_CHUNK_SESSIONS
): RangeBarRequest[] {
  const request = normalizedRequest(input);
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

function intradayIntervalMinutes(granularity: BarGranularity): number | null {
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

function intradayCoverage(
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

export function routeBarProviders(
  request: RangeBarRequest
): Array<"alpaca" | "polygon" | "yahoo" | "stooq"> {
  if (request.venue === "ASX") return ["yahoo"];
  if (request.venue === "INDEX") {
    if (request.ticker === "AXJO") return ["yahoo"];
    return request.granularity === "1Day" ? ["stooq", "yahoo"] : ["yahoo"];
  }
  if (request.venue === "US") {
    return request.granularity === "1Day" && request.adjusted !== false
      ? ["yahoo", "polygon", "alpaca"]
      : ["alpaca", "polygon", "yahoo"];
  }
  return [];
}

export function rangeCacheKey(input: RangeBarRequest): string {
  const request = normalizedRequest(input);
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

function exchangeToday(now: Date, calendar: ExchangeCalendar): string {
  const parts = partsInZone(now, calendarZone(calendar));
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function rangeCacheTtlSeconds(
  input: RangeBarRequest,
  now: Date = new Date()
): number {
  const request = normalizedRequest(input);
  if (request.endSession < exchangeToday(now, request.calendar)) {
    return request.granularity === "1Day" ? 86_400 : 3_600;
  }
  return request.granularity === "1Min" ? 120 : 300;
}

export function rangeCacheTtlMs(input: RangeBarRequest, now: Date = new Date()): number {
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

function providerSymbol(
  request: RangeBarRequest,
  provider: "alpaca" | "polygon" | "yahoo" | "stooq"
): string {
  if (request.instrumentSymbol) return request.instrumentSymbol;
  if (provider === "yahoo" && request.venue === "ASX") {
    return request.ticker.endsWith(".AX") ? request.ticker : `${request.ticker}.AX`;
  }
  if (provider === "yahoo" && request.venue === "INDEX") {
    return YAHOO_INDEX_SYMBOLS[request.ticker] ?? request.ticker;
  }
  if (provider === "stooq" && request.venue === "INDEX") {
    return STOOQ_INDEX_SYMBOLS[request.ticker] ?? request.ticker;
  }
  return request.ticker;
}

function sessionForTimestamp(timestamp: string, calendar: ExchangeCalendar): string {
  const parts = partsInZone(new Date(timestamp), calendarZone(calendar));
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validBar(bar: OhlcvBar): boolean {
  return (
    !Number.isNaN(Date.parse(bar.timestamp)) &&
    DATE_PATTERN.test(bar.session) &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    bar.open >= 0 &&
    bar.high >= 0 &&
    bar.low >= 0 &&
    bar.close >= 0 &&
    bar.volume >= 0
  );
}

function normalizeBars(
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
        DATE_PATTERN.test(input.session) && input.session
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

function alpacaToBar(bar: AlpacaBar, calendar: ExchangeCalendar): OhlcvBar {
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

function defaultAlpacaProvider(
  fetcher: typeof getAlpacaBars,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    if (request.adjusted === false) {
      throw new Error("the existing Alpaca adapter only exposes adjusted bars");
    }
    const raw: AlpacaBar[] = [];
    for (const chunk of chunkRangeBarRequest(request)) {
      const bounds = sessionRangeToBounds(chunk);
      raw.push(
        ...(await fetcher(
          providerSymbol(request, "alpaca"),
          request.granularity as AlpacaTimeframe,
          bounds.fromISO,
          bounds.toISO
        ))
      );
    }
    const bars = raw.map((bar) => alpacaToBar(bar, request.calendar));
    return {
      bars,
      provenance: createProvenance({
        provider: "alpaca",
        fetchedAt: now(),
        adjustment: "split+dividend",
        requestStart: request.startSession,
        requestEnd: request.endSession,
      }),
    };
  };
}

function polygonPath(request: RangeBarRequest): string {
  const [multiplier, span] =
    request.granularity === "1Day"
      ? ["1", "day"]
      : request.granularity === "15Min"
        ? ["15", "minute"]
        : ["1", "minute"];
  const symbol = providerSymbol(request, "polygon");
  const params = new URLSearchParams({
    adjusted: String(request.adjusted !== false),
    sort: "asc",
    limit: "50000",
  });
  return `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${span}/${request.startSession}/${request.endSession}?${params}`;
}

function defaultPolygonProvider(
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
      const time = finite(row.t);
      const open = finite(row.o);
      const high = finite(row.h);
      const low = finite(row.l);
      const close = finite(row.c);
      const volume = finite(row.v);
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
          trades: finite(row.n) ?? undefined,
          vwap: finite(row.vw) ?? undefined,
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function defaultYahooProvider(
  fetcher: (url: string, init: RequestInit) => Promise<JsonResponse>,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    const symbol = providerSymbol(request, "yahoo");
    const bars: OhlcvBar[] = [];
    let adjustedAvailable = request.adjusted === false;
    let lastUrl: string | undefined;
    for (const chunk of chunkRangeBarRequest(request)) {
      const bounds = sessionRangeToBounds(chunk);
      const url = new URL(`${YAHOO_CHART_URL}${encodeURIComponent(symbol)}`);
      url.searchParams.set("period1", String(Math.floor(bounds.fromMs / 1_000)));
      url.searchParams.set("period2", String(Math.ceil(bounds.toMs / 1_000)));
      url.searchParams.set(
        "interval",
        request.granularity === "1Day"
          ? "1d"
          : request.granularity === "15Min"
            ? "15m"
            : "1m"
      );
      url.searchParams.set("events", "div,splits");
      url.searchParams.set(
        "includeAdjustedClose",
        String(request.adjusted !== false)
      );
      lastUrl = url.toString();
      const response = await fetcher(lastUrl, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 TradeIntel-StockSage/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Yahoo bars responded with ${response.status}`);
      }
      const root = object(await response.json());
      const chart = object(root?.chart);
      if (
        !chart ||
        chart.error != null ||
        !Array.isArray(chart.result)
      ) {
        throw new Error("Yahoo returned no chart result");
      }
      const result = object(chart.result[0]);
      const meta = object(result?.meta);
      if (
        !result ||
        !meta ||
        String(meta.symbol ?? "").toUpperCase() !== symbol
      ) {
        throw new Error("Yahoo returned a different instrument");
      }
      if (
        request.venue === "ASX" &&
        (String(meta.currency ?? "").toUpperCase() !== "AUD" ||
          !["ASX", "ASX_ALL_MARKETS"].includes(
            String(meta.exchangeName ?? meta.fullExchangeName ?? "").toUpperCase()
          ))
      ) {
        throw new Error("Yahoo ASX identity validation failed");
      }
      const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
      const indicators = object(result.indicators);
      const quote = Array.isArray(indicators?.quote)
        ? object(indicators.quote[0])
        : null;
      const adjusted = Array.isArray(indicators?.adjclose)
        ? object(indicators.adjclose[0])
        : null;
      const opens = Array.isArray(quote?.open) ? quote.open : [];
      const highs = Array.isArray(quote?.high) ? quote.high : [];
      const lows = Array.isArray(quote?.low) ? quote.low : [];
      const closes = Array.isArray(quote?.close) ? quote.close : [];
      const volumes = Array.isArray(quote?.volume) ? quote.volume : [];
      const adjustedCloses = Array.isArray(adjusted?.adjclose)
        ? adjusted.adjclose
        : [];
      bars.push(
        ...timestamps.flatMap((rawTimestamp, index): OhlcvBar[] => {
          const seconds = finite(rawTimestamp);
          const rawOpen = finite(opens[index]);
          const rawHigh = finite(highs[index]);
          const rawLow = finite(lows[index]);
          const rawClose = finite(closes[index]);
          const volume = finite(volumes[index]) ?? 0;
          if (
            seconds === null ||
            rawOpen === null ||
            rawHigh === null ||
            rawLow === null ||
            rawClose === null ||
            rawClose <= 0
          ) {
            return [];
          }
          const adjustedClose = finite(adjustedCloses[index]);
          if (
            request.adjusted !== false &&
            (adjustedClose === null || adjustedClose <= 0)
          ) {
            return [];
          }
          const factor =
            request.adjusted !== false
              ? (adjustedClose as number) / rawClose
              : 1;
          if (request.adjusted !== false && adjustedClose !== null) {
            adjustedAvailable = true;
          }
          const timestamp = new Date(seconds * 1_000).toISOString();
          return [
            {
              timestamp,
              session: sessionForTimestamp(timestamp, request.calendar),
              open: rawOpen * factor,
              high: rawHigh * factor,
              low: rawLow * factor,
              close: rawClose * factor,
              volume,
            },
          ];
        })
      );
    }
    return {
      bars,
      partial: request.adjusted !== false && !adjustedAvailable,
      reason:
        request.adjusted !== false && !adjustedAvailable
          ? "adjustment_unavailable"
          : undefined,
      provenance: createProvenance({
        provider: "yahoo",
        fetchedAt: now(),
        sourceUrl: lastUrl,
        adjustment:
          request.adjusted === false
            ? "none"
            : adjustedAvailable
              ? "split+dividend"
              : "provider_default",
        requestStart: request.startSession,
        requestEnd: request.endSession,
        delayed: true,
      }),
    };
  };
}

export function parseStooqRangeCsv(
  csv: string,
  calendar: ExchangeCalendar = "US"
): OhlcvBar[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open,high,low,close(?:,volume)?/i.test(lines[0])) {
    return [];
  }
  return lines.slice(1).flatMap((line): OhlcvBar[] => {
    const [session, o, h, l, c, v] = line.split(",").map((cell) => cell.trim());
    const open = Number(o);
    const high = Number(h);
    const low = Number(l);
    const close = Number(c);
    const volume = v ? Number(v) : 0;
    if (
      !DATE_PATTERN.test(session) ||
      ![open, high, low, close, volume].every(Number.isFinite)
    ) {
      return [];
    }
    const timestamp = new Date(
      zonedDateTimeMs(session, calendar === "AU" ? 16 : 16, 0, calendarZone(calendar))
    ).toISOString();
    return [{ timestamp, session, open, high, low, close, volume }];
  });
}

function defaultStooqProvider(
  fetcher: (url: string, init: RequestInit) => Promise<TextResponse>,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    if (request.granularity !== "1Day") {
      return { bars: [], partial: true, reason: "unsupported_granularity" };
    }
    const symbol = providerSymbol(request, "stooq");
    const url = new URL(STOOQ_HISTORY_URL);
    url.searchParams.set("s", symbol);
    url.searchParams.set("i", "d");
    url.searchParams.set("d1", request.startSession.replaceAll("-", ""));
    url.searchParams.set("d2", request.endSession.replaceAll("-", ""));
    const response = await fetcher(url.toString(), {
      cache: "no-store",
      headers: {
        Accept: "text/csv,text/plain,*/*",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TradeIntel-StockSage/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Stooq bars responded with ${response.status}`);
    const csv = await response.text();
    if (/<(?:html|script|form)\b/i.test(csv)) throw new Error("Stooq returned HTML");
    return {
      bars: parseStooqRangeCsv(csv, request.calendar),
      partial: request.adjusted !== false,
      reason: request.adjusted !== false ? "adjustment_unavailable" : undefined,
      provenance: createProvenance({
        provider: "stooq",
        fetchedAt: now(),
        sourceUrl: url.toString(),
        adjustment: "none",
        requestStart: request.startSession,
        requestEnd: request.endSession,
        delayed: true,
      }),
    };
  };
}

function isAvailable(
  provider: "alpaca" | "polygon" | "yahoo" | "stooq",
  dependencies: RangeBarDependencies
): boolean {
  const explicit = dependencies.availability?.[provider];
  if (explicit !== undefined) return explicit;
  if (dependencies.providers?.[provider]) return true;
  if (provider === "alpaca") return Boolean(dependencies.alpaca) || hasAlpaca;
  if (provider === "polygon") return Boolean(dependencies.polygonFetch) || hasPolygon;
  return true;
}

function providerAdapter(
  provider: "alpaca" | "polygon" | "yahoo" | "stooq",
  dependencies: RangeBarDependencies,
  now: () => Date
): RangeBarProvider {
  const injected = dependencies.providers?.[provider];
  if (injected) return injected;
  if (provider === "alpaca") {
    return defaultAlpacaProvider(dependencies.alpaca ?? getAlpacaBars, now);
  }
  if (provider === "polygon") {
    return defaultPolygonProvider(dependencies.polygonFetch ?? polygonFetch, now);
  }
  if (provider === "yahoo") {
    return defaultYahooProvider(dependencies.yahooFetch ?? fetch, now);
  }
  return defaultStooqProvider(dependencies.stooqFetch ?? fetch, now);
}

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
  const coverage = intradayCoverage(request, []);
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
    ...coverage,
    attemptedProviders,
    cacheKey,
  };
}

export async function getBarsForRange(
  input: RangeBarRequest,
  dependencies: RangeBarDependencies = {}
): Promise<RangeBarSeries> {
  const request = normalizedRequest(input);
  const cacheKey = rangeCacheKey(request);
  const cached = await dependencies.cache?.get(cacheKey);
  if (cached) return cached;

  const now = dependencies.now ?? (() => new Date());
  const attemptedProviders: MarketDataProvider[] = [];
  let lastReason: RangeBarReason = "no_data";
  let bestPartial: RangeBarSeries | undefined;
  for (const provider of routeBarProviders(request)) {
    if (!isAvailable(provider, dependencies)) continue;
    attemptedProviders.push(provider);
    try {
      const result = await providerAdapter(provider, dependencies, now)(request);
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
        instrumentSymbol: providerSymbol(request, provider),
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
      const score =
        series.missingSessions.length +
        (series.missingBars ?? 0) +
        (series.reason === "adjustment_unavailable" ? 1_000_000 : 0);
      const bestScore = bestPartial
        ? bestPartial.missingSessions.length +
          (bestPartial.missingBars ?? 0) +
          (bestPartial.reason === "adjustment_unavailable" ? 1_000_000 : 0)
        : Number.POSITIVE_INFINITY;
      if (score < bestScore) bestPartial = series;
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

export function quoteMetricsFromSeries(
  series: RangeBarSeries,
  intervals: readonly TemporalInterval[] = [],
  livePrice?: { price: number; dayPct: number }
): ChatQuote | null {
  const dailyClose = new Map<string, number>();
  for (const bar of series.bars) dailyClose.set(bar.session, bar.close);
  const points = [...dailyClose].map(([date, value]) => ({ date, value }));
  const latest = points.at(-1);
  const previous = points.at(-2);
  if (!latest) return null;
  const dayPct =
    livePrice?.dayPct ??
    (previous && previous.value > 0
      ? ((latest.value - previous.value) / previous.value) * 100
      : 0);
  const quote = buildChatQuote(
    points,
    {
      ticker: series.ticker,
      price: livePrice?.price ?? latest.value,
      dayPct,
      eod: Boolean(series.provenance?.delayed),
      sourceNote: series.provenance?.proxyFor
        ? `${series.instrumentSymbol} proxy for ${series.provenance.proxyFor}`
        : undefined,
      isIndex: series.venue === "INDEX" && !series.provenance?.proxyFor,
      proxySymbol: series.provenance?.proxyFor
        ? series.instrumentSymbol
        : undefined,
      proxyKind:
        series.provenance?.proxyKind === "adr" ||
        series.provenance?.proxyKind === "etf"
          ? series.provenance.proxyKind
          : undefined,
    },
    intervals
  );
  return quote
    ? {
        ...quote,
        instrumentSymbol: series.instrumentSymbol,
        venue: series.venue === "UNKNOWN" ? undefined : series.venue,
      }
    : null;
}

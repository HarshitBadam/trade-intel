import type { ExchangeCalendar } from "../../provenance";
import { createProvenance } from "../../provenance";
import {
  calendarZone,
  RANGE_BAR_DATE_PATTERN,
  zonedDateTimeMs,
} from "../range-bar-calendar";
import { rangeBarProviderSymbol } from "../range-bar-routing";
import type {
  OhlcvBar,
  RangeBarProvider,
  TextResponse,
} from "../range-bar-types";

const STOOQ_HISTORY_URL = "https://stooq.com/q/d/l/";
const FETCH_TIMEOUT_MS = 8_000;

export function parseStooqRangeCsv(
  csv: string,
  calendar: ExchangeCalendar = "US"
): OhlcvBar[] {
  const lines = csv.trim().split(/\r?\n/);
  if (
    lines.length < 2 ||
    !/^date,open,high,low,close(?:,volume)?/i.test(lines[0])
  ) {
    return [];
  }
  return lines.slice(1).flatMap((line): OhlcvBar[] => {
    const [session, o, h, l, c, v] = line
      .split(",")
      .map((cell) => cell.trim());
    const open = Number(o);
    const high = Number(h);
    const low = Number(l);
    const close = Number(c);
    const volume = v ? Number(v) : 0;
    if (
      !RANGE_BAR_DATE_PATTERN.test(session) ||
      ![open, high, low, close, volume].every(Number.isFinite)
    ) {
      return [];
    }
    const timestamp = new Date(
      zonedDateTimeMs(session, 16, 0, calendarZone(calendar))
    ).toISOString();
    return [{ timestamp, session, open, high, low, close, volume }];
  });
}

export function createStooqRangeBarProvider(
  fetcher: (url: string, init: RequestInit) => Promise<TextResponse>,
  now: () => Date
): RangeBarProvider {
  return async (request) => {
    if (request.granularity !== "1Day") {
      return { bars: [], partial: true, reason: "unsupported_granularity" };
    }
    const symbol = rangeBarProviderSymbol(request, "stooq");
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
    if (!response.ok) {
      throw new Error(`Stooq bars responded with ${response.status}`);
    }
    const csv = await response.text();
    if (/<(?:html|script|form)\b/i.test(csv)) {
      throw new Error("Stooq returned HTML");
    }
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

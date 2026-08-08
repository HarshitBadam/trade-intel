import type { ChatQuote } from "./types";

export type QuoteMetricPoint = {
  date: string;
  value: number;
};

type QuoteMetricOptions = {
  ticker: string;
  price: number;
  dayPct: number;
  eod?: boolean;
  sourceNote?: string;
  isIndex?: boolean;
  proxySymbol?: string;
  proxyKind?: "etf" | "adr";
};

export function buildChatQuote(
  points: QuoteMetricPoint[],
  options: QuoteMetricOptions
): ChatQuote | null {
  const normalizedPoints = points.flatMap((point): QuoteMetricPoint[] => {
    const sessionDate = point.date.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (
      !sessionDate ||
      !Number.isFinite(Date.parse(`${sessionDate}T00:00:00.000Z`))
    ) {
      return [];
    }
    return [{ ...point, date: sessionDate }];
  });
  if (normalizedPoints.length < 2) return null;

  const latestIndex = normalizedPoints.length - 1;
  const latest = normalizedPoints[latestIndex];
  const percentFrom = (sessions: number): number | null => {
    const index = latestIndex - sessions;
    const baseline = normalizedPoints[index]?.value;
    return baseline > 0
      ? ((latest.value - baseline) / baseline) * 100
      : null;
  };
  const dateFrom = (sessions: number): string | undefined =>
    normalizedPoints[latestIndex - sessions]?.date;
  const firstIndexMatching = (prefix: string): number =>
    normalizedPoints.findIndex((point) => point.date.startsWith(prefix));
  const baselineFor = (firstIndex: number): number =>
    firstIndex > 0 ? firstIndex - 1 : firstIndex;

  const previousSessionPct =
    latestIndex >= 2 && normalizedPoints[latestIndex - 2].value > 0
      ? ((normalizedPoints[latestIndex - 1].value -
          normalizedPoints[latestIndex - 2].value) /
          normalizedPoints[latestIndex - 2].value) *
        100
      : null;
  const yearBase = baselineFor(firstIndexMatching(latest.date.slice(0, 4)));
  const monthBase = baselineFor(firstIndexMatching(latest.date.slice(0, 7)));
  const percentFromBase = (index: number): number | null => {
    const baseline = normalizedPoints[index]?.value;
    return index >= 0 && index < latestIndex && baseline > 0
      ? ((latest.value - baseline) / baseline) * 100
      : null;
  };
  const dateFromBase = (index: number): string | undefined =>
    index >= 0 && index < latestIndex
      ? normalizedPoints[index].date
      : undefined;
  const shiftDate = (value: string, days: number): string => {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const firstOfMonth = (value: string): string => `${value.slice(0, 7)}-01`;
  const previousMonthEnd = shiftDate(firstOfMonth(latest.date), -1);
  const previousMonthStart = firstOfMonth(previousMonthEnd);
  const latestDay = new Date(`${latest.date}T00:00:00.000Z`).getUTCDay();
  const currentWeekStart = shiftDate(
    latest.date,
    -(latestDay === 0 ? 6 : latestDay - 1)
  );
  const previousWeekStart = shiftDate(currentWeekStart, -7);
  const previousWeekEnd = shiftDate(currentWeekStart, -1);
  const rangeReturn = (
    start: string,
    end: string
  ): { value: number | null; start?: string; end?: string } => {
    const first = normalizedPoints.findIndex((point) => point.date >= start);
    let last = -1;
    for (
      let index = normalizedPoints.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (normalizedPoints[index].date <= end) {
        last = index;
        break;
      }
    }
    if (first < 0 || last < first) return { value: null };
    const baselineIndex = first > 0 ? first - 1 : first;
    const baseline = normalizedPoints[baselineIndex]?.value;
    const final = normalizedPoints[last]?.value;
    return {
      value:
        baselineIndex < last && baseline > 0
          ? ((final - baseline) / baseline) * 100
          : null,
      start: normalizedPoints[first]?.date,
      end: normalizedPoints[last]?.date,
    };
  };
  const weekToDate = rangeReturn(currentWeekStart, latest.date);
  const lastWeek = rangeReturn(previousWeekStart, previousWeekEnd);
  const lastMonth = rangeReturn(previousMonthStart, previousMonthEnd);

  return {
    ticker: options.ticker,
    price: options.price,
    asOf: latest.date,
    ...(options.eod === undefined ? {} : { eod: options.eod }),
    ...(options.sourceNote ? { sourceNote: options.sourceNote } : {}),
    ...(options.isIndex === undefined ? {} : { isIndex: options.isIndex }),
    ...(options.proxySymbol ? { proxySymbol: options.proxySymbol } : {}),
    ...(options.proxyKind ? { proxyKind: options.proxyKind } : {}),
    dayPct: options.dayPct,
    prevSessionPct: previousSessionPct,
    prevSessionDate: dateFrom(1),
    fewDaysPct: percentFrom(3),
    weekPct: percentFrom(5),
    wtdPct: weekToDate.value,
    lastWeekPct: lastWeek.value,
    monthPct: percentFrom(21),
    lastMonthPct: lastMonth.value,
    yearPct: percentFrom(252),
    ytdPct: percentFromBase(yearBase),
    ytdStart: dateFromBase(yearBase),
    mtdPct: percentFromBase(monthBase),
    mtdStart: dateFromBase(monthBase),
    fewDaysStart: dateFrom(3),
    weekStart: dateFrom(5),
    wtdStart: weekToDate.start,
    lastWeekStart: lastWeek.start,
    lastWeekEnd: lastWeek.end,
    monthStart: dateFrom(21),
    lastMonthStart: lastMonth.start,
    lastMonthEnd: lastMonth.end,
    yearStart: dateFrom(252),
  };
}

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
  if (points.length < 2) return null;

  const latestIndex = points.length - 1;
  const latest = points[latestIndex];
  const percentFrom = (sessions: number): number | null => {
    const index = latestIndex - sessions;
    const baseline = points[index]?.value;
    return baseline > 0
      ? ((latest.value - baseline) / baseline) * 100
      : null;
  };
  const dateFrom = (sessions: number): string | undefined =>
    points[latestIndex - sessions]?.date;
  const firstIndexMatching = (prefix: string): number =>
    points.findIndex((point) => point.date.startsWith(prefix));
  const baselineFor = (firstIndex: number): number =>
    firstIndex > 0 ? firstIndex - 1 : firstIndex;

  const previousSessionPct =
    latestIndex >= 2 && points[latestIndex - 2].value > 0
      ? ((points[latestIndex - 1].value - points[latestIndex - 2].value) /
          points[latestIndex - 2].value) *
        100
      : null;
  const yearBase = baselineFor(firstIndexMatching(latest.date.slice(0, 4)));
  const monthBase = baselineFor(firstIndexMatching(latest.date.slice(0, 7)));
  const percentFromBase = (index: number): number | null => {
    const baseline = points[index]?.value;
    return index >= 0 && index < latestIndex && baseline > 0
      ? ((latest.value - baseline) / baseline) * 100
      : null;
  };
  const dateFromBase = (index: number): string | undefined =>
    index >= 0 && index < latestIndex ? points[index].date : undefined;

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
    monthPct: percentFrom(21),
    yearPct: percentFrom(252),
    ytdPct: percentFromBase(yearBase),
    ytdStart: dateFromBase(yearBase),
    mtdPct: percentFromBase(monthBase),
    mtdStart: dateFromBase(monthBase),
    fewDaysStart: dateFrom(3),
    weekStart: dateFrom(5),
    monthStart: dateFrom(21),
    yearStart: dateFrom(252),
  };
}

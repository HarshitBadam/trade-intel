import type { TemporalInterval } from "@/lib/market-calendar";
import { buildChatQuote } from "./quote-metrics";
import type { ChatQuote } from "../types";
import type { RangeBarSeries } from "./range-bar-types";

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

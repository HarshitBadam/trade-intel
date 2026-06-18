"use client";

import { useMemo, useState } from "react";
import MainChart from "./MainChart";

type ChartPoint = { date: string | number; value: number };

const DAY_MS = 24 * 60 * 60 * 1000;

// `days: 1` is the sentinel for the intraday (1D) view, which renders the
// 5-minute session series instead of the daily candles.
const RANGES: { label: string; days: number; blurb: string }[] = [
  { label: "1D", days: 1, blurb: "today" },
  { label: "1W", days: 7, blurb: "past week" },
  { label: "1M", days: 30, blurb: "past month" },
  { label: "3M", days: 90, blurb: "past 3 months" },
  { label: "6M", days: 180, blurb: "past 6 months" },
  { label: "1Y", days: 365, blurb: "past year" },
  { label: "All", days: Infinity, blurb: "all time" },
];

function normalize(data?: ChartPoint[]) {
  if (!Array.isArray(data)) return [] as { t: number; v: number }[];
  return data
    .map((p) => ({
      t: typeof p.date === "number" ? p.date : new Date(p.date).getTime(),
      v: p.value,
    }))
    .filter((p) => !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);
}

export function StockGraph({
  companyName,
  stockPrice,
  priceChange,
  percentChange,
  chartData,
  intradayData,
  weekData,
  fineData,
  hasShuffle,
}: {
  companyName: string;
  stockPrice: number;
  priceChange: number;
  percentChange: number;
  chartData: ChartPoint[];
  intradayData?: ChartPoint[];
  weekData?: ChartPoint[];
  fineData?: ChartPoint[];
  hasShuffle: boolean;
}) {
  const [rangeDays, setRangeDays] = useState<number>(365);

  const priceLabel = `$${(stockPrice ?? 0).toFixed(2)}`;

  const dailyPoints = useMemo(() => normalize(chartData), [chartData]);
  const intradayPoints = useMemo(() => normalize(intradayData), [intradayData]);
  const weekPoints = useMemo(() => normalize(weekData), [weekData]);
  const finePoints = useMemo(() => normalize(fineData), [fineData]);

  const has1D = intradayPoints.length >= 2;
  const hasWeek = weekPoints.length >= 2;
  const hasFine = finePoints.length >= 2;
  // Bucketing per range: 1D → 5-min session (time axis), 1W → 15-min bars,
  // 1M / 3M → 1-hour bars (date axis, hundreds of points), 6M+ → daily candles.
  const isIntraday = rangeDays === 1;
  const isWeek = rangeDays === 7 && hasWeek;
  const isFine = (rangeDays === 30 || rangeDays === 90) && hasFine;
  const activePoints = isIntraday
    ? intradayPoints
    : isWeek
    ? weekPoints
    : isFine
    ? finePoints
    : dailyPoints;

  // Span of the DAILY history, so the longer ranges can be disabled when the
  // data doesn't reach back that far.
  const spanDays = useMemo(() => {
    if (dailyPoints.length < 2) return 0;
    return (
      (dailyPoints[dailyPoints.length - 1].t - dailyPoints[0].t) / DAY_MS
    );
  }, [dailyPoints]);

  // The change shown next to the price reflects the SELECTED range (first vs.
  // last visible point) — for 1D that's the intraday session, otherwise the
  // daily window. Falls back to the server's daily change when data is sparse.
  const windowChange = useMemo(() => {
    if (activePoints.length < 2) return { abs: priceChange, pct: percentChange };
    let series = activePoints;
    if (!isIntraday && rangeDays !== Infinity) {
      const latest = activePoints[activePoints.length - 1].t;
      const filtered = activePoints.filter(
        (p) => p.t >= latest - rangeDays * DAY_MS
      );
      series = filtered.length >= 2 ? filtered : activePoints;
    }
    const first = series[0].v;
    const last = series[series.length - 1].v;
    const abs = last - first;
    const pct = first !== 0 ? (abs / first) * 100 : 0;
    return { abs, pct };
  }, [activePoints, isIntraday, rangeDays, priceChange, percentChange]);

  const isUp = windowChange.abs >= 0;
  const sign = isUp ? "+" : "";
  const blurb =
    RANGES.find((r) => r.days === rangeDays)?.blurb ?? "selected range";
  const changeLabel = `${sign}${windowChange.abs.toFixed(2)} (${sign}${windowChange.pct.toFixed(2)}%) ${blurb}`;

  const chartSeries = isIntraday
    ? intradayData ?? []
    : isWeek
    ? weekData ?? []
    : isFine
    ? fineData ?? []
    : chartData;

  return (
    <div className="w-full h-full shadow-md bg-accent/10 rounded-lg flex flex-col">
      <div className="flex justify-between">
        <div className="stock-text-description-left p-8">
          <h2 className="text-2xl font-bold">{companyName}</h2>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{priceLabel}</span>
            <span className={isUp ? "text-green-600 dark:text-green-400 text-sm" : "text-red-500 dark:text-red-400 text-sm"}>
              {changeLabel}
            </span>
          </div>

          <div className="flex gap-1 mt-3">
            {RANGES.map((r) => {
              const disabled =
                r.days === 1
                  ? !has1D
                  : r.days !== Infinity && r.days > spanDays + 1;
              const active = rangeDays === r.days;
              return (
                <button
                  key={r.label}
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    // The card flips on click; don't let a range change bubble
                    // up and flip to the popularity view.
                    e.stopPropagation();
                    setRangeDays(r.days);
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  } ${disabled ? "opacity-30" : "cursor-pointer"}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>

        {hasShuffle && (
          <div className="flex items-center gap-2 p-8 text-muted-foreground text-xs">
            <img src="/shuffle.svg" alt="shuffle" className="w-4 h-4" />
            <span className="stock-text-description-right">
              Switch to Popularity View
            </span>
          </div>
        )}
      </div>

      <div className="text-muted-foreground px-5 pb-5">
        {chartData ? (
          <MainChart cd={chartSeries} rangeDays={rangeDays} intraday={isIntraday} />
        ) : (
          <p>Loading chart data...</p>
        )}
      </div>
    </div>
  );
}

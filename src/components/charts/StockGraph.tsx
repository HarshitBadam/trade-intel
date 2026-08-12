"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import MainChart from "./MainChart";

type ChartPoint = { date: string | number; value: number };

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGES: { label: string; days: number; blurb: string }[] = [
  { label: "1D", days: 1, blurb: "today" },
  { label: "1W", days: 7, blurb: "past week" },
  { label: "1M", days: 30, blurb: "past month" },
  { label: "3M", days: 90, blurb: "past 3 months" },
  { label: "6M", days: 180, blurb: "past 6 months" },
  { label: "1Y", days: 365, blurb: "past year" },
  { label: "All", days: Infinity, blurb: "all time" },
];

function rangeToKind(
  days: number,
): "intraday" | "week" | "fine" | null {
  if (days === 1) return "intraday";
  if (days === 7) return "week";
  if (days === 30 || days === 90) return "fine";
  return null;
}

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
  onRequestRange,
  loadingRange,
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
  onRequestRange?: (kind: "intraday" | "week" | "fine") => void;
  loadingRange?: boolean;
}) {
  const [rangeDays, setRangeDays] = useState<number>(365);

  const priceLabel = stockPrice > 0 ? `$${stockPrice.toFixed(2)}` : ", ";

  const dailyPoints = useMemo(() => normalize(chartData), [chartData]);
  const intradayPoints = useMemo(() => normalize(intradayData), [intradayData]);
  const weekPoints = useMemo(() => normalize(weekData), [weekData]);
  const finePoints = useMemo(() => normalize(fineData), [fineData]);

  const has1D = intradayPoints.length >= 2;
  const hasWeek = weekPoints.length >= 2;
  const hasFine = finePoints.length >= 2;
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

  const spanDays = useMemo(() => {
    if (dailyPoints.length < 2) return 0;
    return (
      (dailyPoints[dailyPoints.length - 1].t - dailyPoints[0].t) / DAY_MS
    );
  }, [dailyPoints]);

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

  const subDaily = isIntraday || isWeek || isFine;

  const showIntradayLoading =
    !!loadingRange && isIntraday && !has1D && !!onRequestRange;

  return (
    <div className="w-full h-full shadow-md bg-accent/10 glass-card rounded-lg flex flex-col">
      <div className="flex justify-between">
        <div className="stock-text-description-left p-8">
          <h2 className="text-2xl font-bold">{companyName}</h2>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{priceLabel}</span>
            {activePoints.length >= 2 && (
              <span className={isUp ? "text-green-600 dark:text-green-400 text-sm" : "text-red-500 dark:text-red-400 text-sm"}>
                {changeLabel}
              </span>
            )}
          </div>

          <div className="flex gap-1 mt-3">
            {RANGES.map((r) => {
              const kind = rangeToKind(r.days);
              const hiResAvailable =
                r.days === 1 ? has1D : r.days === 7 ? hasWeek : hasFine;

              const disabled = (() => {
                if (kind && onRequestRange) return false;
                if (r.days === 1) return !has1D;
                return r.days !== Infinity && r.days > spanDays + 1;
              })();

              const active = rangeDays === r.days;
              return (
                <button
                  key={r.label}
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRangeDays(r.days);
                    if (onRequestRange && kind && !hiResAvailable) {
                      onRequestRange(kind);
                    }
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
            <Image src="/shuffle.svg" alt="shuffle" width={16} height={16} />
            <span className="stock-text-description-right">
              Switch to Popularity View
            </span>
          </div>
        )}
      </div>

      <div className="text-muted-foreground px-5 pb-5">
        {showIntradayLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
          </div>
        ) : activePoints.length >= 2 ? (
          <MainChart cd={chartSeries} rangeDays={rangeDays} intraday={isIntraday} subDaily={subDaily} />
        ) : (
          <div className="py-24 text-center text-sm space-y-2">
            <p>Chart data isn&apos;t available for {companyName}.</p>
            <a
              href={`https://www.google.com/search?q=${encodeURIComponent(`${companyName} stock`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-primary underline underline-offset-2 hover:opacity-80"
            >
              Search for it online →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

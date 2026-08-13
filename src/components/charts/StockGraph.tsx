"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import MainChart from "./MainChart";
import { RangeSelector } from "./RangeSelector";
import { DAY_MS } from "./ranges";

type ChartPoint = { date: string | number; value: number };

// Blurbs for the price-change caption aren't part of the shared range
// selector (PopularityGraph has no equivalent caption), so they stay local.
const RANGE_BLURBS: Record<number, string> = {
  1: "today",
  7: "past week",
  30: "past month",
  90: "past 3 months",
  180: "past 6 months",
  365: "past year",
  [Infinity]: "all time",
};

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
  const blurb = RANGE_BLURBS[rangeDays] ?? "selected range";
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

          <RangeSelector
            rangeDays={rangeDays}
            onSelect={setRangeDays}
            has1D={has1D}
            hasWeek={hasWeek}
            hasFine={hasFine}
            spanDays={spanDays}
            onRequestRange={onRequestRange}
          />
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

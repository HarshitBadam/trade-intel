"use client"
import Image from "next/image"
import * as React from "react"
import { PopularityChart } from "./PopularityChart"
import { RangeSelector } from "./RangeSelector"
import { DAY_MS } from "./ranges"
import type { BarPoint, News } from "@/lib/market-data/types"

interface PopularityGraphProps {
  companyName: string;
  popularityRate: number;
  mentions: number;
  searchVolume: number;
  sentimentPercentage: number;
  status: "live" | "sample";
  chartData: BarPoint[];
  intradayData?: BarPoint[];
  weekData?: BarPoint[];
  fineData?: BarPoint[];
  news: News[];
  onRequestRange?: (kind: "intraday" | "week" | "fine") => void;
  loadingRange?: boolean;
}

export function PopularityGraph({
  companyName,
  popularityRate,
  mentions,
  searchVolume,
  sentimentPercentage,
  status,
  chartData,
  intradayData,
  weekData,
  fineData,
  news,
  onRequestRange,
  loadingRange,
}: PopularityGraphProps) {
  const [rangeDays, setRangeDays] = React.useState<number>(365);

  const has1D = (intradayData?.length ?? 0) >= 2;
  const hasWeek = (weekData?.length ?? 0) >= 2;
  const hasFine = (fineData?.length ?? 0) >= 2;

  const isIntraday = rangeDays === 1;
  const isWeek = rangeDays === 7 && hasWeek;
  const isFine = (rangeDays === 30 || rangeDays === 90) && hasFine;

  const activeBars: BarPoint[] = isIntraday
    ? intradayData ?? []
    : isWeek
      ? weekData ?? []
      : isFine
        ? fineData ?? []
        : chartData;

  const subDaily = isIntraday || isWeek || isFine;

  const spanDays = React.useMemo(() => {
    if (chartData.length < 2) return 0;
    const first = Date.parse(chartData[0].date);
    const last = Date.parse(chartData[chartData.length - 1].date);
    return Number.isNaN(first) || Number.isNaN(last) ? 0 : (last - first) / DAY_MS;
  }, [chartData]);

  const showIntradayLoading =
    !!loadingRange && isIntraday && !has1D && !!onRequestRange;

  return (
    <div className="w-full h-full shadow-md bg-accent/10 glass-card rounded-lg flex flex-col">
      <div className="flex justify-between">
        <div className="stock-text-description-left p-8">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold">{companyName}</h2>
            {status === "sample" && (
              <span
                className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground border border-border rounded-full px-2 py-0.5"
                title="Illustrative sample data, not a live feed."
              >
                Illustrative
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{popularityRate}</span>
            <span className="text-sm text-muted-foreground">popularity score</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-2">
            <div className="text-muted-foreground text-sm">Mentions: {mentions.toLocaleString()}</div>
            {searchVolume > 0 && (
              <div className="text-muted-foreground text-sm">Volume: {searchVolume.toLocaleString()}</div>
            )}
            <div className="text-muted-foreground text-sm">{sentimentPercentage}% Positive Sentiment</div>
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

        <div className="flex items-center gap-2 p-8 text-muted-foreground text-xs">
          <Image src="/shuffle.svg" alt="shuffle" width={16} height={16} />
          <span className="stock-text-description-right">Switch to Stock Price View</span>
        </div>
      </div>

      {showIntradayLoading ? (
        <div className="flex items-center justify-center py-24">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
        </div>
      ) : activeBars.length >= 2 ? (
        <PopularityChart
          bars={activeBars}
          news={news}
          rangeDays={rangeDays}
          intraday={isIntraday}
          subDaily={subDaily}
        />
      ) : (
        <p className="py-24 text-center text-sm text-muted-foreground">
          Activity data is temporarily unavailable. Retrying automatically.
        </p>
      )}
    </div>
  )
}

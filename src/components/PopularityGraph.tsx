"use client"
import * as React from "react"
import { PopularityChart } from "./PopularityChart"

interface PopularityGraphProps {
  companyName: string;
  ticker?: string;
  popularityRate: number;
  mentions: number;
  searchVolume: number;
  sentimentPercentage: number;
}

// Social/popularity history only spans ~3 months of data, so wider windows are
// disabled — keeping the selector visually consistent with the price view.
const RANGES: { label: string; days: number }[] = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "All", days: Infinity },
];

const POPULARITY_SPAN_DAYS = 90;

export function PopularityGraph({
  companyName,
  ticker,
  popularityRate,
  mentions,
  searchVolume,
  sentimentPercentage
}: PopularityGraphProps) {
  const [rangeDays, setRangeDays] = React.useState<number>(90);

  return (
    <div className="w-full h-full shadow-md bg-accent/10 rounded-lg flex flex-col">

      <div className="flex justify-between">
        <div className="stock-text-description-left p-8">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold">{companyName}</h2>
            <span
              className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground border border-border rounded-full px-2 py-0.5"
              title="Social sentiment is illustrative sample data, not a live feed."
            >
              Illustrative
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{popularityRate}</span>
            <span className="text-sm text-muted-foreground">popularity score</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-2">
            <div className="text-muted-foreground text-sm">Mentions: {mentions.toLocaleString()} today</div>
            <div className="text-muted-foreground text-sm">Search Volume: {searchVolume.toLocaleString()}</div>
            <div className="text-muted-foreground text-sm">{sentimentPercentage}% Positive Sentiment</div>
          </div>

          <div className="flex gap-1 mt-3">
            {RANGES.map((r) => {
              const disabled = r.days !== Infinity && r.days > POPULARITY_SPAN_DAYS + 1;
              const active = rangeDays === r.days;
              return (
                <button
                  key={r.label}
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    // Don't let a range change bubble up and flip the card.
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

        <div className="flex items-center gap-2 p-8 text-muted-foreground text-xs">
          <img src="/shuffle.svg" alt="shuffle" className="w-4 h-4" />
          <span className="stock-text-description-right">Switch to Stock Price View</span>
        </div>
      </div>

      <PopularityChart ticker={ticker ?? companyName} rangeDays={rangeDays} />
    </div>
  )
} 
"use client";

import { RANGES, rangeToKind } from "./ranges";

interface RangeSelectorProps {
  rangeDays: number;
  onSelect: (days: number) => void;
  has1D: boolean;
  hasWeek: boolean;
  hasFine: boolean;
  spanDays: number;
  onRequestRange?: (kind: "intraday" | "week" | "fine") => void;
}

export function RangeSelector({
  rangeDays,
  onSelect,
  has1D,
  hasWeek,
  hasFine,
  spanDays,
  onRequestRange,
}: RangeSelectorProps) {
  return (
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
              onSelect(r.days);
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
  );
}

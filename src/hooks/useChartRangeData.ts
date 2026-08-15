"use client";

import { useCallback, useRef, useState } from "react";
import { fetchChartRange } from "@/app/details/[id]/actions";
import type { BarPoint } from "@/lib/market-data/types";

export type ChartRangeKind = "intraday" | "week" | "fine";

export type ChartRangeInitialData = {
  intradayData?: BarPoint[];
  weekData?: BarPoint[];
  fineData?: BarPoint[];
};

export type ChartRangeData = {
  intradayData: BarPoint[] | undefined;
  weekData: BarPoint[] | undefined;
  fineData: BarPoint[] | undefined;
  loadingRange: boolean;
  handleRequestRange: (kind: ChartRangeKind) => Promise<void>;
};

/**
 * Lazily loads per-range chart data on demand (a chart only requests a
 * range once, via `handleRequestRange`), deduping concurrent/repeat
 * requests per kind and tracking a single `loadingRange` flag across
 * however many ranges are in flight at once.
 */
export function useChartRangeData(
  ticker: string,
  initial: ChartRangeInitialData
): ChartRangeData {
  const [intradayData, setIntradayData] = useState<BarPoint[] | undefined>(
    initial.intradayData
  );
  const [weekData, setWeekData] = useState<BarPoint[] | undefined>(
    initial.weekData
  );
  const [fineData, setFineData] = useState<BarPoint[] | undefined>(
    initial.fineData
  );
  const [loadingRange, setLoadingRange] = useState(false);
  const fetchedRanges = useRef(new Set<ChartRangeKind>());
  const loadingCount = useRef(0);

  const handleRequestRange = useCallback(
    async (kind: ChartRangeKind) => {
      if (fetchedRanges.current.has(kind)) return;
      fetchedRanges.current.add(kind);
      loadingCount.current++;
      setLoadingRange(true);
      try {
        const data = await fetchChartRange(ticker, kind);
        if (data.length < 2) fetchedRanges.current.delete(kind);
        switch (kind) {
          case "intraday":
            setIntradayData(data);
            break;
          case "week":
            setWeekData(data);
            break;
          case "fine":
            setFineData(data);
            break;
        }
      } catch {
        fetchedRanges.current.delete(kind);
      } finally {
        loadingCount.current--;
        if (loadingCount.current === 0) setLoadingRange(false);
      }
    },
    [ticker]
  );

  return { intradayData, weekData, fineData, loadingRange, handleRequestRange };
}

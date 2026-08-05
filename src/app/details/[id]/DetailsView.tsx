"use client";

import { StockGraph } from "@/components/charts/StockGraph";
import { RecentInfluential } from "@/components/news/RecentInfluential";
import { SearchBar } from "@/components/layout/SearchBar";
import { FlipCard } from "@/components/shared/FlipCard";
import { PopularityGraph } from "@/components/charts/PopularityGraph";
import { FloatingWidget } from "@/components/chat/FloatingWidget";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDetails,
  fetchChartRange,
  pollDetailsRefresh,
  requestDetailsRefresh,
} from "./actions";
import type { BarPoint } from "@/lib/market-data/types";
import type { StockData } from "./page";
import {
  computeRetryAfterSec,
  deriveActiveRefreshState,
  POLL_DELAYS_MS,
} from "@/lib/market-intelligence/types";

function ChartCardSkeleton() {
  return (
    <div className="w-full h-full shadow-md bg-accent/10 glass-card rounded-lg flex flex-col animate-pulse">
      <div className="p-8 space-y-4">
        <div className="h-7 w-40 rounded bg-muted" />
        <div className="flex items-baseline gap-3">
          <div className="h-9 w-32 rounded bg-muted" />
          <div className="h-4 w-28 rounded bg-muted" />
        </div>
        <div className="flex gap-1 pt-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-6 w-9 rounded-md bg-muted" />
          ))}
        </div>
      </div>
      <div className="flex-1 px-8 pb-8">
        <div className="h-full w-full rounded-lg bg-muted/50" />
      </div>
    </div>
  );
}

function SentimentPanelSkeleton() {
  return (
    <div className="w-full rounded-lg p-6 glass-card shadow-md flex flex-col h-full animate-pulse">
      <div className="pb-8 space-y-4">
        <div className="h-6 w-48 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
      </div>
      <div className="pb-8 space-y-3">
        <div className="h-6 w-44 rounded bg-muted" />
        <div className="h-8 w-full rounded bg-muted" />
      </div>
      <div className="space-y-4">
        <div className="h-6 w-40 rounded bg-muted" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-4">
            <div className="h-10 w-10 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/2 rounded bg-muted" />
              <div className="h-3 w-full rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DetailsView({
  initial,
  ticker,
}: {
  initial: StockData;
  ticker: string;
}) {
  const [stockData, setStockData] = useState<StockData>(initial);
  const news = stockData.news;

  useEffect(() => {
    if (
      initial.newsStatus === "sample" ||
      initial.intelligence.state === "fresh" ||
      initial.intelligence.state === "no_news"
    ) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = POLL_DELAYS_MS;

    const run = async () => {
      const requested = await requestDetailsRefresh(ticker);
      if (cancelled) return;
      if (!requested.ok) {
        setStockData((current) => ({
          ...current,
          intelligence: {
            ...current.intelligence,
            refreshState: "failed",
            retryAfterSec: requested.retryAfterSec,
          },
        }));
        return;
      }
      const { workId } = requested.job;
      if (requested.job.state === "failed") {
        setStockData((current) => ({
          ...current,
          intelligence: {
            ...current.intelligence,
            refreshState: "failed",
            retryAfterSec: computeRetryAfterSec(requested.job.retryAfter),
          },
        }));
        return;
      }
      setStockData((current) => ({
        ...current,
        intelligence: {
          ...current.intelligence,
          refreshState: deriveActiveRefreshState(requested.job.state),
          retryAfterSec: undefined,
        },
      }));

      const poll = async (attempt: number): Promise<void> => {
        if (cancelled) return;
        if (attempt >= delays.length) {
          // Active polling stops here (~2 minutes), but the durable job on
          // the server may still be queued/running. "backgrounded" is an
          // honest terminal state: never collapse known outstanding work
          // into "idle".
          setStockData((current) => ({
            ...current,
            intelligence: {
              ...current.intelligence,
              refreshState: "backgrounded",
            },
          }));
          return;
        }
        timer = setTimeout(async () => {
          const job = await pollDetailsRefresh(workId).catch(() => null);
          if (cancelled) return;
          if (job?.state === "done") {
            const refreshed = await fetchDetails(ticker).catch(() => null);
            if (!refreshed || cancelled) return;
            setStockData((current) =>
              refreshed.intelligence.generation >= current.intelligence.generation
                ? refreshed
                : current
            );
            return;
          }
          if (job?.state === "failed") {
            setStockData((current) => ({
              ...current,
              newsStatus:
                current.news.length > 0 ? "degraded" : current.newsStatus,
              intelligence: {
                ...current.intelligence,
                refreshState: "failed",
                retryAfterSec: computeRetryAfterSec(job.retryAfter),
              },
            }));
            return;
          }
          setStockData((current) => ({
            ...current,
            intelligence: {
              ...current.intelligence,
              refreshState: deriveActiveRefreshState(job?.state),
              retryAfterSec: undefined,
            },
          }));
          await poll(attempt + 1);
        }, delays[attempt]);
      };
      await poll(0);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [initial, ticker]);

  const [intradayData, setIntradayData] = useState<BarPoint[] | undefined>(
    initial.intradayData,
  );
  const [weekData, setWeekData] = useState<BarPoint[] | undefined>(
    initial.weekData,
  );
  const [fineData, setFineData] = useState<BarPoint[] | undefined>(
    initial.fineData,
  );
  const [loadingRange, setLoadingRange] = useState(false);
  const fetchedRanges = useRef(new Set<string>());
  const loadingCount = useRef(0);

  const handleRequestRange = useCallback(
    async (kind: "intraday" | "week" | "fine") => {
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
    [ticker],
  );

  return (
    <div className="min-h-screen">
      <div className="max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 p-8">
            <div className="space-y-6">
              <SearchBar />
              <div className="mt-8 h-[600px]">
                {stockData ? (
                  <FlipCard
                    front={
                      <StockGraph
                        companyName={stockData.companyName}
                        stockPrice={stockData.stockPrice || 0}
                        priceChange={stockData.priceChange}
                        percentChange={stockData.percentChange}
                        chartData={stockData.chartData}
                        intradayData={intradayData}
                        weekData={weekData}
                        fineData={fineData}
                        hasShuffle={true}
                        onRequestRange={handleRequestRange}
                        loadingRange={loadingRange}
                      />
                    }
                    back={
                      <PopularityGraph
                        companyName={stockData.companyName}
                        popularityRate={stockData.popularityRate}
                        mentions={stockData.mentions}
                        searchVolume={stockData.searchVolume}
                        sentimentPercentage={stockData.sentimentPercentage}
                        status={stockData.popularityStatus}
                        chartData={stockData.chartData}
                        intradayData={intradayData}
                        weekData={weekData}
                        fineData={fineData}
                        news={news}
                        onRequestRange={handleRequestRange}
                        loadingRange={loadingRange}
                      />
                    }
                  />
                ) : (
                  <ChartCardSkeleton />
                )}
              </div>
            </div>
          </div>

          {/* Absolutely positioned so it fills (and never exceeds) the chart
              column's height, its bottom lines up with the chart, and the
              news list scrolls internally. */}
          <div className="lg:col-span-4 relative">
            <div className="p-8 lg:pl-0 lg:absolute lg:inset-0">
              {stockData ? (
                <RecentInfluential
                  news={news}
                  status={stockData.newsStatus}
                  updatedAt={stockData.newsUpdatedAt}
                  verdict={stockData.newsVerdict}
                  ticker={stockData.id}
                  refreshState={stockData.intelligence.refreshState}
                  retryAfterSec={stockData.intelligence.retryAfterSec}
                  positiveSentimentPercentage={
                    stockData.positiveSentimentPercentage || 0
                  }
                  negativeSentimentPercentage={
                    stockData.negativeSentimentPercentage || 0
                  }
                />
              ) : (
                <SentimentPanelSkeleton />
              )}
            </div>
          </div>

          <FloatingWidget />

        </div>
      </div>
    </div>
  );
}

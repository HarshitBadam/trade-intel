"use client";

import { StockGraph } from "@/components/charts/StockGraph";
import { RecentInfluential } from "@/components/news/RecentInfluential";
import { SearchBar } from "@/components/layout/SearchBar";
import TopGainer, { TopGainerSkeleton } from "@/components/stocks/TopGainer";
import { FlipCard } from "@/components/shared/FlipCard";
import { PopularityGraph } from "@/components/charts/PopularityGraph";
import { FloatingWidget } from "@/components/chat/FloatingWidget";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { News, NewsStatus } from "@/components/news/RecentInfluential";
import { fetchDetails, fetchRelatedStocks, fetchChartRange } from "./actions";
import type { RelatedCard, BarPoint } from "@/lib/market-data/types";
import type { StockData } from "./page";

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

function mergeDetails(prev: StockData, fresh: StockData): StockData {
  return {
    ...fresh,
    ...(fresh.priceStatus === "unavailable" && prev.priceStatus === "live"
      ? {
          stockPrice: prev.stockPrice,
          priceChange: prev.priceChange,
          percentChange: prev.percentChange,
          chartData: prev.chartData,
          priceStatus: prev.priceStatus,
        }
      : {}),
    ...(fresh.newsStatus === "unavailable" && prev.news.length > 0
      ? {
          news: prev.news,
          newsStatus: prev.newsStatus,
          newsUpdatedAt: prev.newsUpdatedAt,
          newsVerdict: prev.newsVerdict,
          mentions: prev.mentions,
          sentimentPercentage: prev.sentimentPercentage,
          positiveSentimentPercentage: prev.positiveSentimentPercentage,
          negativeSentimentPercentage: prev.negativeSentimentPercentage,
          popularityRate: prev.popularityRate,
          popularitySeries: prev.popularitySeries,
          popularityStatus: prev.popularityStatus,
          searchVolume: prev.searchVolume,
        }
      : {}),
    ...(!fresh.newsVerdict && prev.newsVerdict
      ? { newsVerdict: prev.newsVerdict }
      : {}),
  };
}

const TERMINAL_NEWS: ReadonlySet<NewsStatus> = new Set<NewsStatus>([
  "fresh",
  "stale",
  "live",
  "unavailable",
  "sample",
]);

export default function DetailsView({
  initial,
  ticker,
}: {
  initial: StockData;
  ticker: string;
}) {
  const router = useRouter();

  const [stockData, setStockData] = useState<StockData>(initial);
  const [news, setNews] = useState<News[]>(initial.news);
  const stockDataRef = useRef(stockData);
  useEffect(() => {
    stockDataRef.current = stockData;
  }, [stockData]);

  useEffect(() => {
    if (initial.newsStatus !== "analyzing") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const POLL_MS = 8_000;
    const MAX_ATTEMPTS = 5;
    let attempts = 0;

    const poll = () => {
      fetchDetails(ticker)
        .then((data) => {
          if (cancelled || !data) return;
          const merged = mergeDetails(stockDataRef.current, data);
          setStockData(merged);
          setNews(merged.news);
          attempts += 1;
          if (!TERMINAL_NEWS.has(data.newsStatus) && attempts < MAX_ATTEMPTS) {
            timer = setTimeout(poll, POLL_MS);
          }
        })
        .catch(() => {
          if (!cancelled && attempts < MAX_ATTEMPTS) {
            attempts += 1;
            timer = setTimeout(poll, POLL_MS);
          }
        });
    };

    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [initial.newsStatus, ticker]);

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

  const [related, setRelated] = useState<RelatedCard[] | null>(null);
  const relatedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRelated(null);
    const el = relatedRef.current;
    if (!el) return;

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const MAX_ATTEMPTS = 3;

    const load = (attempt = 0) => {
      fetchRelatedStocks(ticker)
        .then((r) => {
          if (!cancelled) setRelated(r);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) {
            retry = setTimeout(() => load(attempt + 1), 1000 * 2 ** attempt);
          } else {
            setRelated([]);
          }
        });
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !cancelled) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      observer.disconnect();
    };
  }, [ticker]);

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
              column's height — its bottom lines up with the chart, and the
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

          <div ref={relatedRef} className="lg:col-span-12">
            {related === null ? (
              <div className="px-8 pb-12">
                <h2 className="text-xl font-semibold mb-4 text-start">
                  Related Stocks
                </h2>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <TopGainerSkeleton key={i} />
                  ))}
                </div>
              </div>
            ) : related.length > 0 ? (
              <div className="px-8 pb-12">
                <h2 className="text-xl font-semibold mb-4 text-start">
                  Related Stocks
                </h2>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {related.map(({ title, data }) => (
                    <div
                      key={data.ticker}
                      className="cursor-pointer"
                      onClick={() => router.push(`/details/${data.ticker}`)}
                      onMouseEnter={() =>
                        router.prefetch(`/details/${data.ticker}`)
                      }
                    >
                      <TopGainer title={title} data={data} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

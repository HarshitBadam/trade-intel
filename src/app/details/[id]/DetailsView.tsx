"use client";

import { StockGraph } from "@/components/StockGraph";
import { RecentInfluential } from "@/components/RecentInfluential";
import { SearchBar } from "@/components/SearchBar";
import TopGainer, { TopGainerSkeleton } from "@/components/TopGainer";
import { FlipCard } from "@/components/FlipCard";
import { PopularityGraph } from "@/components/PopularityGraph";
import { FloatingWidget } from "@/components/FloatingWidget";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { News } from "@/components/RecentInfluential";
import { fetchDetails, fetchRelatedStocks, fetchChartRange } from "./actions";
import type { RelatedCard } from "@/lib/market-data-types";
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

export default function DetailsView({
  initial,
  ticker,
}: {
  initial: StockData;
  ticker: string;
}) {
  const router = useRouter();

  // ── Core data (seeded from SSR, updated by news polling) ──────────────
  const [stockData, setStockData] = useState<StockData>(initial);
  const [news, setNews] = useState<News[]>(initial.news);

  useEffect(() => {
    if (initial.newsStatus !== "analyzing") return;

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const MAX_RETRIES = 3;
    let attempts = 0;

    const poll = () => {
      fetchDetails(ticker).then((data) => {
        if (cancelled || !data) return;
        const stillAnalyzing = data.newsStatus === "analyzing";
        const giveUp = stillAnalyzing && attempts >= MAX_RETRIES;
        if (giveUp) {
          data = {
            ...data,
            newsStatus: data.news.length > 0 ? "live" : "sample",
          };
        }
        setStockData(data);
        setNews(data.news);
        if (stillAnalyzing && !giveUp) {
          attempts += 1;
          retry = setTimeout(poll, 30_000);
        }
      });
    };

    retry = setTimeout(poll, 30_000);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [initial.newsStatus, ticker]);

  // ── Lazy chart ranges ────────────────────────────────────────────────
  const [intradayData, setIntradayData] = useState<
    { date: string; value: number }[] | undefined
  >(initial.intradayData);
  const [weekData, setWeekData] = useState<
    { date: string; value: number }[] | undefined
  >(initial.weekData);
  const [fineData, setFineData] = useState<
    { date: string; value: number }[] | undefined
  >(initial.fineData);
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
      } finally {
        loadingCount.current--;
        if (loadingCount.current === 0) setLoadingRange(false);
      }
    },
    [ticker],
  );

  // ── Deferred related stocks rail ─────────────────────────────────────
  const [related, setRelated] = useState<RelatedCard[] | null>(null);
  const relatedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRelated(null);
    const el = relatedRef.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !cancelled) {
          observer.disconnect();
          fetchRelatedStocks(ticker).then((r) => {
            if (!cancelled) setRelated(r);
          });
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [ticker]);

  return (
    <div className="min-h-screen">
      <div className="max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Content - Takes up 8 columns on large screens */}
          <div className="lg:col-span-8 p-8">
            <div className="space-y-6">
              <SearchBar />
              {/* Stock Graph Section */}
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
                        ticker={stockData.id}
                        popularityRate={stockData.popularityRate}
                        mentions={stockData.mentions}
                        searchVolume={stockData.searchVolume}
                        sentimentPercentage={stockData.sentimentPercentage}
                      />
                    }
                  />
                ) : (
                  <ChartCardSkeleton />
                )}
              </div>
            </div>
          </div>

          {/* Recent Influential Section - Takes up 4 columns on large screens.
              On large screens the inner panel is absolutely positioned so it
              fills (and never exceeds) the chart column's height — its bottom
              lines up with the chart, and the news list scrolls internally. */}
          <div className="lg:col-span-4 relative">
            <div className="p-8 lg:pl-0 lg:absolute lg:inset-0">
              {stockData ? (
                <RecentInfluential
                  news={news}
                  status={stockData.newsStatus}
                  updatedAt={stockData.newsUpdatedAt}
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

          {/* Related Stocks Section — companies genuinely comparable to the one
              being viewed (same sector → closest market cap, via Polygon
              fundamentals), with live prices. Skeletons while loading; hidden
              only if nothing relevant could be found. */}
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

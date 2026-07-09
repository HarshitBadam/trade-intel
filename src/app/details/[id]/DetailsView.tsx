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
import type { News } from "@/components/news/RecentInfluential";
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

// A refresh may itself fail transiently ("unavailable"); never let it regress
// data that is already on screen — keep the good values and only adopt the
// parts of the fresh payload that are real.
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
  };
}

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
  // Set once the price poll below exhausts its retries while still unavailable
  // — lets the chart swap its message from "retrying" to an honest dead end
  // with a way out, instead of claiming to retry forever.
  const [priceGaveUp, setPriceGaveUp] = useState(false);
  const stockDataRef = useRef(stockData);
  useEffect(() => {
    stockDataRef.current = stockData;
  }, [stockData]);

  useEffect(() => {
    // "analyzing": an AI ingest is running in the background. "unavailable":
    // a live fetch failed transiently (e.g. the Polygon budget was spent) —
    // both resolve on their own, so both are worth re-polling.
    setPriceGaveUp(false);
    const transient =
      initial.newsStatus === "analyzing" ||
      initial.newsStatus === "unavailable" ||
      initial.priceStatus === "unavailable";
    if (!transient) return;

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const MAX_RETRIES = 6;
    let attempts = 0;

    const poll = () => {
      fetchDetails(ticker).then((data) => {
        if (cancelled || !data) return;
        const stillPending =
          data.newsStatus === "analyzing" ||
          data.newsStatus === "unavailable" ||
          data.priceStatus === "unavailable";
        const giveUp = stillPending && attempts >= MAX_RETRIES;
        if (giveUp && data.newsStatus === "analyzing") {
          // Mirrors the server's `isNewsStale` rule (NEWS_TTL_MS = 7 days).
          // Replicated inline to avoid pulling the server data layer into the
          // client bundle. If the analysis we have is older than the TTL and
          // the background refresh never landed, label it "stale" — never
          // "fresh" — so we don't present week-plus-old data as up to date.
          // With nothing at all to show, settle on the honest "unavailable"
          // (never "sample": no fabricated headlines for end users).
          const NEWS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
          const isStale =
            !!data.newsUpdatedAt &&
            Date.now() - Date.parse(data.newsUpdatedAt) > NEWS_TTL_MS;
          data = {
            ...data,
            newsStatus: data.newsUpdatedAt
              ? isStale
                ? "stale"
                : "fresh"
              : data.news.length > 0
                ? "live"
                : "unavailable",
          };
        }
        const merged = mergeDetails(stockDataRef.current, data);
        setStockData(merged);
        setNews(merged.news);
        if (stillPending && !giveUp) {
          attempts += 1;
          retry = setTimeout(poll, 30_000);
        } else if (giveUp && merged.priceStatus === "unavailable") {
          setPriceGaveUp(true);
        }
      });
    };

    retry = setTimeout(poll, 30_000);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [initial.newsStatus, initial.priceStatus, ticker]);

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
      // Both FlipCard faces (price + popularity) share this one handler, so the
      // dedup below is load-bearing: mark the range as in-flight BEFORE the
      // await so a click on the second face never re-fetches a resolution the
      // first face already requested. One fetch per resolution feeds both charts.
      if (fetchedRanges.current.has(kind)) return;
      fetchedRanges.current.add(kind);
      loadingCount.current++;
      setLoadingRange(true);
      try {
        const data = await fetchChartRange(ticker, kind);
        // An empty series means the fetch was rate-limited/failed (the chart
        // falls back to the daily view). Un-mark the range so a later click
        // retries instead of being stuck on the fallback until a reload.
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
                        gaveUp={priceGaveUp}
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

"use client";
import { StockGraph } from "@/components/StockGraph";
import { RecentInfluential } from "@/components/RecentInfluential";
import { SearchBar } from "@/components/SearchBar";
import TopGainer from "@/components/TopGainer";
import { FlipCard } from "@/components/FlipCard";
import { PopularityGraph } from "@/components/PopularityGraph";
import { FloatingWidget } from "@/components/FloatingWidget";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { News, NewsStatus } from "@/components/RecentInfluential";
import { fetchDetails, fetchMovers, type Movers } from "./actions";
import { moverToCard } from "@/lib/movers";

// Shown while the client-side fetch for the selected ticker is in flight so the
// page never flashes an empty chart card / 0% sentiment panel.
function ChartCardSkeleton() {
  return (
    <div className="w-full h-full shadow-md bg-accent/10 rounded-lg flex flex-col animate-pulse">
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
    <div className="w-full rounded-lg p-6 shadow-md flex flex-col h-full animate-pulse">
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

export type StockData = {
  id: string;
  companyName: string;
  stockPrice: number | undefined;
  priceChange: number;
  percentChange: number;
  popularityRate: number;
  mentions: number;
  searchVolume: number;
  sentimentPercentage: number;
  positiveSentimentPercentage: number;
  negativeSentimentPercentage: number;
  chartData: { date: string; value: number }[];
  intradayData?: { date: string; value: number }[];
  weekData?: { date: string; value: number }[];
  fineData?: { date: string; value: number }[];
  news: News[]; // Assuming news is an array of strings (e.g., URLs or headlines)
  newsStatus: NewsStatus;
  newsUpdatedAt?: string;
};

export default function Home() {
  const params = useParams();
  const router = useRouter();
  const stockId = String(params.id);

  // Fetch data from the API
  const [stockData, setStockData] = useState<StockData>();

  const [news, setNews] = useState<News[]>([]);

  useEffect(() => {
    let cancelled = false;
    // While news is being enriched in the background (`analyzing`), poll a few
    // more times so the placeholder upgrades to the AI-analysed Astra rows. Cap
    // the retries so we don't poll forever if enrichment can't complete (e.g.
    // Gemini quota) — after that we just keep showing the live headlines.
    let retry: ReturnType<typeof setTimeout> | undefined;
    const MAX_RETRIES = 3;
    let attempts = 0;

    const load = () => {
      fetchDetails(stockId).then((data) => {
        if (cancelled || !data) return;
        const stillAnalyzing = data.newsStatus === "analyzing";
        const giveUp = stillAnalyzing && attempts >= MAX_RETRIES;
        // Stop the perpetual "analyzing" badge once we've given up retrying.
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
          retry = setTimeout(load, 30_000);
        }
      });
    };

    load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [stockId]);

  // Real market movers for the "Trending Stocks" rail (replaces the old fake
  // "similar performance / sector / market cap" cards).
  const [movers, setMovers] = useState<Movers | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchMovers().then((m) => {
      if (!cancelled) setMovers(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pick three distinct tickers (Top Gainer / Loser / Most Active), skipping the
  // one currently being viewed so the rail always shows different stocks.
  const trending = useMemo(() => {
    if (!movers) return [] as { title: string; data: ReturnType<typeof moverToCard> }[];
    const current = stockId.toUpperCase();
    const used = new Set<string>([current]);
    const pick = (list: typeof movers.gainers) =>
      list.find((m) => !used.has(m.ticker));
    const out: { title: string; data: ReturnType<typeof moverToCard> }[] = [];
    const add = (title: string, m?: (typeof movers.gainers)[number]) => {
      if (!m) return;
      used.add(m.ticker);
      out.push({ title, data: moverToCard(m) });
    };
    add("Top Gainer", pick(movers.gainers));
    add("Top Loser", pick(movers.losers));
    add("Most Active", pick(movers.mostActive));
    return out;
  }, [movers, stockId]);

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
                        intradayData={stockData.intradayData}
                        weekData={stockData.weekData}
                        fineData={stockData.fineData}
                        hasShuffle={true}
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

          {/* Trending Stocks Section — real market movers (Polygon), not the
              current ticker. Replaces the old mock "similar" cards. */}
          {trending.length > 0 && (
            <div className="lg:col-span-12 px-8 pb-12">
              <h2 className="text-xl font-semibold mb-4 text-start">
                Trending Stocks
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {trending.map(({ title, data }) => (
                  <div
                    key={data.ticker}
                    className="cursor-pointer"
                    onClick={() => router.push(`/details/${data.ticker}`)}
                  >
                    <TopGainer title={title} data={data} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";
import { StockGraph } from "@/components/StockGraph";
import { RecentInfluential } from "@/components/RecentInfluential";
import { SearchBar } from "@/components/SearchBar";
import { StockChips } from "@/components/StockChips";
import ColorPalette from "@/components/ColorPalette";
import TopGainer from "@/components/TopGainer";
import { FlipCard } from "@/components/FlipCard";
import { Divide } from "lucide-react";
import { PopularityGraph } from "@/components/PopularityGraph";
import { FloatingWidget } from "@/components/FloatingWidget";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { News, NewsStatus } from "@/components/RecentInfluential";
import { fetchDetails } from "./actions";
import { getRelatedStocks } from "@/data/fallbacks";

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

  // Distinct, deterministic peer stocks for the related rails (was previously
  // three identical hardcoded AAPL cards).
  const relatedStocks = useMemo(() => getRelatedStocks(stockId, 3), [stockId]);

  // Fetch data from the API
  const [stockData, setStockData] = useState<StockData>();

  const [news, setNews] = useState<News[]>([]);

  useEffect(() => {
    let cancelled = false;
    // When the news is being enriched in the background (`analyzing`), poll once
    // more after ~30s so the placeholder upgrades to the AI-analysed Astra rows.
    let retry: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      fetchDetails(stockId).then((data) => {
        if (cancelled || !data) return;
        setStockData(data);
        setNews(data.news);
        if (data.newsStatus === "analyzing") {
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

  return (
    <div className="min-h-screen">
      <div className="max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Content - Takes up 8 columns on large screens */}
          <div className="lg:col-span-8 p-8">
            <div className="space-y-6">
              <SearchBar />
              {/* <StockChips /> */}
              {/* Stock Graph Section */}
              <div className="mt-8 h-[600px]">
                <FlipCard
                  front={
                    stockData && (
                      <StockGraph
                        companyName={stockData?.companyName}
                        stockPrice={(stockData?.stockPrice || 0)}
                        priceChange={stockData?.priceChange}
                        percentChange={stockData?.percentChange}
                        chartData={stockData?.chartData}
                        intradayData={stockData?.intradayData}
                        weekData={stockData?.weekData}
                        fineData={stockData?.fineData}
                        hasShuffle={true}
                      />
                    )
                  }
                  back={ stockData &&
                    <PopularityGraph
                      companyName={stockData?.companyName}
                      popularityRate={stockData?.popularityRate}
                      mentions={stockData?.mentions}
                      searchVolume={stockData?.searchVolume}
                      sentimentPercentage={stockData?.sentimentPercentage}
                    />
                  }
                />
              </div>
            </div>
          </div>

          {/* Recent Influential Section - Takes up 4 columns on large screens.
              On large screens the inner panel is absolutely positioned so it
              fills (and never exceeds) the chart column's height — its bottom
              lines up with the chart, and the news list scrolls internally. */}
          <div className="lg:col-span-4 relative">
            <div className="p-8 lg:pl-0 lg:absolute lg:inset-0">
              <RecentInfluential
                news={news}
                status={stockData?.newsStatus}
                updatedAt={stockData?.newsUpdatedAt}
                positiveSentimentPercentage={
                  stockData?.positiveSentimentPercentage || 0
                }
                negativeSentimentPercentage={
                  stockData?.negativeSentimentPercentage || 0
                }
              />
            </div>
          </div>

          <FloatingWidget />

          {/* Related Stocks Section */}
          <div className="lg:col-span-12 px-8 pb-12">
            <h2 className="text-xl font-semibold mb-4 text-start">
              Scroll down to see related stocks ↓
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {["Similar Performance", "Same Sector", "Similar Market Cap"].map(
                (label, i) =>
                  relatedStocks[i] ? (
                    <div
                      key={relatedStocks[i].ticker}
                      className="cursor-pointer"
                      onClick={() =>
                        router.push(`/details/${relatedStocks[i].ticker}`)
                      }
                    >
                      <TopGainer title={label} data={relatedStocks[i]} />
                    </div>
                  ) : null
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

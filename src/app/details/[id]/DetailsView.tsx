"use client";

import { StockGraph } from "@/components/charts/StockGraph";
import { RecentInfluential } from "@/components/news/RecentInfluential";
import { SearchBar } from "@/components/layout/SearchBar";
import { FlipCard } from "@/components/shared/FlipCard";
import { PopularityGraph } from "@/components/charts/PopularityGraph";
import { FloatingWidget } from "@/components/chat/FloatingWidget";
import { useTickerIntelligenceRefresh } from "@/hooks/useTickerIntelligenceRefresh";
import { useChartRangeData } from "@/hooks/useChartRangeData";
import type { StockData } from "@/lib/market-intelligence/types";
import { ChartCardSkeleton, SentimentPanelSkeleton } from "./DetailsSkeletons";

export default function DetailsView({
  initial,
  ticker,
}: {
  initial: StockData;
  ticker: string;
}) {
  const stockData = useTickerIntelligenceRefresh(initial, ticker);
  const news = stockData.news;

  const { intradayData, weekData, fineData, loadingRange, handleRequestRange } =
    useChartRangeData(ticker, initial);

  return (
    <div className="pb-8">
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

"use client"

import { StockGraph } from "@/components/StockGraph"
import { Overview } from "@/components/Overview"
import TopGainer, { TopGainerSkeleton } from "@/components/TopGainer"
import TopNews, { TopNewsSkeleton } from "@/components/TopNews"
import { useParams, useRouter } from "next/navigation";
import { FloatingWidget } from "@/components/FloatingWidget";
import { useEffect, useMemo, useState } from "react";
import { SearchBar } from "@/components/SearchBar"
import { mockStockData } from "@/data/mockStocks";
import { generateMockCandles, generateMockFine, generateMockWeek, generateMockIntraday } from "@/data/fallbacks";
import { fetchMovers, fetchQuote, fetchTopHeadline, type Mover, type Movers, type Quote, type Headline } from "./details/[id]/actions";
import { StockChips } from "@/components/StockChips";
import { RecentInfluential } from "@/components/RecentInfluential";
import { NewsModal, type NewsArticle } from "@/components/NewsModal";
import { type Shift } from "@/components/Overview";
import { moverToCard } from "@/lib/movers";

function moverToShift(m: Mover): Shift {
  const up = m.percentChange >= 0;
  const sign = up ? "+" : "";
  return {
    ticker: m.ticker,
    name: m.name,
    change: `${sign}${m.percentChange.toFixed(2)}%`,
    sentiment: `${up ? "Bullish" : "Bearish"} (${Math.abs(m.percentChange).toFixed(1)}%)`,
  };
}


export default function StocksPage() {
  const router = useRouter();
  const [isWidgetExpanded, setIsWidgetExpanded] = useState(false);
  const [selectedStockId, setSelectedStockId] = useState<number>(1); // Default to first stock

  const handleWidgetOpen = () => {
    setIsWidgetExpanded(true);
  };

  const handleWidgetClose = () => {
    setIsWidgetExpanded(false);
  };

  // Get the current stock data
  const currentStock = mockStockData.find(stock => stock.id === selectedStockId) ?? mockStockData[0];

  // The static mock rows only carry a few candles; generate a full ~1y series
  // (deterministic per ticker) so the chart and its range selector have data.
  const homeChartData = useMemo(
    () => generateMockCandles(currentStock.ticker),
    [currentStock.ticker]
  );
  const homeIntradayData = useMemo(
    () => generateMockIntraday(currentStock.ticker),
    [currentStock.ticker]
  );
  const homeWeekData = useMemo(
    () => generateMockWeek(currentStock.ticker),
    [currentStock.ticker]
  );
  const homeFineData = useMemo(
    () => generateMockFine(currentStock.ticker),
    [currentStock.ticker]
  );

  // Live "Trending Now" quote + "Top News" headline for the selected ticker.
  // Falls back to the deterministic mock above until the live data resolves (and
  // permanently if Polygon is unconfigured / throttled), so the cards never empty.
  const [quote, setQuote] = useState<Quote | null>(null);
  const [headline, setHeadline] = useState<Headline | null>(null);

  // Live "Top Gainers / Losers / Sentiment Shifts" for a curated watchlist.
  // Fetched once; falls back to the static cards until it resolves.
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

  const gainerCard = movers?.gainers[0] ? moverToCard(movers.gainers[0]) : null;
  const loserCard = movers?.losers[0] ? moverToCard(movers.losers[0]) : null;
  const shiftRows = movers?.shifts.length ? movers.shifts.map(moverToShift) : undefined;

  useEffect(() => {
    let cancelled = false;
    setQuote(null);
    setHeadline(null);
    fetchQuote(currentStock.ticker).then((q) => {
      if (!cancelled) setQuote(q);
    });
    fetchTopHeadline(currentStock.ticker).then((h) => {
      if (!cancelled) setHeadline(h);
    });
    return () => {
      cancelled = true;
    };
  }, [currentStock.ticker]);

  const stockPrice = quote?.stockPrice ?? currentStock.stockPrice;
  const priceChange = quote?.priceChange ?? currentStock.priceChange;
  const percentChange = quote?.percentChange ?? currentStock.percentChange;
  const chartData = quote?.chartData ?? homeChartData;
  const intradayData = quote?.intradayData ?? homeIntradayData;
  const weekData = quote?.weekData ?? homeWeekData;
  const fineData = quote?.fineData ?? homeFineData;
  const [openArticle, setOpenArticle] = useState<NewsArticle | null>(null);
  const topNewsArticle: NewsArticle | null = headline
    ? {
        title: headline.newsTitle,
        body: headline.newsContent,
        sentiment: headline.sentiment,
        source: headline.source,
        date: headline.date,
        url: headline.url,
      }
    : null;

  const handleStockClick = () => {
    router.push(`/details/${currentStock.ticker}`);
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Stock Analysis</h1>
        <p className="text-muted-foreground">Track and analyze stock performance with real-time data.</p>
      </div>

      <SearchBar />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between align-end">
            <div className="text-xl font-bold">Trending Now</div>
            <div 
              className="flex items-center gap-1 cursor-pointer content-end hover:opacity-80"
            >
              <StockChips 
                selectedStockId={selectedStockId} 
                onStockSelect={(id) => setSelectedStockId(id ?? 1)} 
              />
            </div>
          </div>
          <div className="cursor-pointer" onClick={handleStockClick}> 
            <StockGraph 
              key={currentStock.id}
              companyName={currentStock.companyName}
              stockPrice={stockPrice}
              priceChange={priceChange}
              percentChange={percentChange}
              chartData={chartData}
              intradayData={intradayData}
              weekData={weekData}
              fineData={fineData}
              hasShuffle={false}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Overview title="Top Sentiment Shifts" shifts={shiftRows} />
          <div 
            className="rounded-lg h-1/2 shadow-md flex flex-col items-start justify-center p-4 cursor-pointer" 
            onClick={handleWidgetOpen}
          >
            <div className="text-4xl font-bold text-black w-full">Ask StockSage.</div>
            <div className="text-sm text-muted-foreground mt-3">
              Your AI-powered market assistant for real-time stock insights and sentiment analysis.
            </div>
          </div>
        </div>
       

        {gainerCard ? (
          <div className="cursor-pointer" onClick={() => router.push(`/details/${gainerCard.ticker}`)}>
            <TopGainer title="Top Gainers" data={gainerCard} />
          </div>
        ) : (
          <TopGainerSkeleton title="Top Gainers" />
        )}
        {loserCard ? (
          <div className="cursor-pointer" onClick={() => router.push(`/details/${loserCard.ticker}`)}>
            <TopGainer title="Top Losers" data={loserCard} />
          </div>
        ) : (
          <TopGainerSkeleton title="Top Losers" />
        )}
        {headline ? (
          <div>
            <TopNews
              title="Top News"
              newsTitle={headline.newsTitle}
              newsContent={headline.newsContent}
              onClick={() => topNewsArticle && setOpenArticle(topNewsArticle)}
            />
          </div>
        ) : (
          <TopNewsSkeleton title="Top News" />
        )}
      </div>
      <FloatingWidget 
        isExpanded={isWidgetExpanded} 
        onClose={handleWidgetClose}
        onOpen={handleWidgetOpen}
      />

      <NewsModal article={openArticle} onClose={() => setOpenArticle(null)} />
    </div>
  )
} 
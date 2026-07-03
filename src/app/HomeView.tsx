"use client";

import { StockGraph } from "@/components/charts/StockGraph";
import { Overview } from "@/components/stocks/Overview";
import TopGainer, { TopGainerSkeleton } from "@/components/stocks/TopGainer";
import TopNews, { TopNewsSkeleton } from "@/components/news/TopNews";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { SearchBar } from "@/components/layout/SearchBar";
import { mockStockData } from "@/data/mockStocks";
import {
  generateMockCandles,
  generateMockFine,
  generateMockWeek,
  generateMockIntraday,
} from "@/data/fallbacks";
import { fetchHomeTicker } from "./details/[id]/actions";
import type { Mover, Movers, Quote, Headline } from "@/lib/market-data/types";
import { StockChips } from "@/components/stocks/StockChips";
import { NewsModal, type NewsArticle } from "@/components/news/NewsModal";
import { type Shift } from "@/components/stocks/Overview";
import { moverToCard } from "@/lib/movers";
import { FloatingWidget } from "@/components/chat/FloatingWidget";
import { useStaleData } from "@/lib/useStaleData";
import { prefetch } from "@/lib/prefetch";

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

const defaultStock =
  mockStockData.find((s) => s.id === 1) ?? mockStockData[0];

const companyToTicker = new Map(
  mockStockData.map((s) => [s.companyName, s.ticker]),
);

interface HomeViewProps {
  initial: {
    movers: Movers;
    quote: Quote;
    headline: Headline;
  };
}

export default function HomeView({ initial }: HomeViewProps) {
  const router = useRouter();
  const [isWidgetExpanded, setIsWidgetExpanded] = useState(false);
  const [selectedStockId, setSelectedStockId] = useState<number>(1);

  const handleWidgetOpen = () => setIsWidgetExpanded(true);
  const handleWidgetClose = () => setIsWidgetExpanded(false);

  const currentStock =
    mockStockData.find((stock) => stock.id === selectedStockId) ??
    mockStockData[0];
  const isDefault = currentStock.ticker === defaultStock.ticker;

  const { data: switchedData } = useStaleData(
    `home:${currentStock.ticker}`,
    () => fetchHomeTicker(currentStock.ticker),
    { enabled: !isDefault },
  );

  const activeQuote: Quote | null = isDefault
    ? initial.quote
    : (switchedData?.quote ?? null);
  const activeHeadline: Headline | null = isDefault
    ? initial.headline
    : (switchedData?.headline ?? null);

  const homeChartData = useMemo(
    () => generateMockCandles(currentStock.ticker),
    [currentStock.ticker],
  );
  const homeIntradayData = useMemo(
    () => generateMockIntraday(currentStock.ticker),
    [currentStock.ticker],
  );
  const homeWeekData = useMemo(
    () => generateMockWeek(currentStock.ticker),
    [currentStock.ticker],
  );
  const homeFineData = useMemo(
    () => generateMockFine(currentStock.ticker),
    [currentStock.ticker],
  );

  const stockPrice = activeQuote?.stockPrice ?? currentStock.stockPrice;
  const priceChange = activeQuote?.priceChange ?? currentStock.priceChange;
  const percentChange = activeQuote?.percentChange ?? currentStock.percentChange;
  const chartData = activeQuote?.chartData ?? homeChartData;
  const intradayData = activeQuote?.intradayData ?? homeIntradayData;
  const weekData = activeQuote?.weekData ?? homeWeekData;
  const fineData = activeQuote?.fineData ?? homeFineData;

  const gainerCard = initial.movers.gainers[0]
    ? moverToCard(initial.movers.gainers[0])
    : null;
  const loserCard = initial.movers.losers[0]
    ? moverToCard(initial.movers.losers[0])
    : null;
  const shiftRows = initial.movers.shifts.length
    ? initial.movers.shifts.map(moverToShift)
    : undefined;

  const [openArticle, setOpenArticle] = useState<NewsArticle | null>(null);
  const topNewsArticle: NewsArticle | null = activeHeadline
    ? {
        title: activeHeadline.newsTitle,
        body: activeHeadline.newsContent,
        sentiment: activeHeadline.sentiment,
        source: activeHeadline.source,
        date: activeHeadline.date,
        url: activeHeadline.url,
      }
    : null;

  const handleStockClick = () => {
    router.push(`/details/${currentStock.ticker}`);
  };

  const handleChipHover = useCallback(
    (e: React.MouseEvent) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn) return;
      const ticker = companyToTicker.get(btn.textContent?.trim() ?? "");
      if (!ticker) return;
      if (ticker !== defaultStock.ticker) {
        prefetch(`home:${ticker}`, () => fetchHomeTicker(ticker));
      }
      router.prefetch(`/details/${ticker}`);
    },
    [router],
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Stock Analysis</h1>
        <p className="text-muted-foreground">
          Track and analyze stock performance with real-time data.
        </p>
      </div>

      <SearchBar />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="md:col-span-2 lg:col-span-2">
          <div className="mb-4 space-y-3">
            <div className="text-xl font-bold">Trending Now</div>
            <div onMouseOver={handleChipHover}>
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

        <div className="flex flex-col gap-6">
          <Overview title="Top Sentiment Shifts" shifts={shiftRows} />
          <div
            className="rounded-lg h-1/2 bg-card glass-card shadow-md flex flex-col items-start justify-center p-4 cursor-pointer"
            onClick={handleWidgetOpen}
          >
            <div className="text-4xl font-bold siri-text w-full">
              Ask StockSage.
            </div>
            <div className="text-sm text-muted-foreground mt-3">
              Your AI-powered market assistant for real-time stock insights and
              sentiment analysis.
            </div>
          </div>
        </div>

        {gainerCard ? (
          <div
            className="cursor-pointer"
            onClick={() => router.push(`/details/${gainerCard.ticker}`)}
            onMouseEnter={() =>
              router.prefetch(`/details/${gainerCard.ticker}`)
            }
          >
            <TopGainer title="Top Gainers" data={gainerCard} />
          </div>
        ) : (
          <TopGainerSkeleton title="Top Gainers" />
        )}
        {loserCard ? (
          <div
            className="cursor-pointer"
            onClick={() => router.push(`/details/${loserCard.ticker}`)}
            onMouseEnter={() =>
              router.prefetch(`/details/${loserCard.ticker}`)
            }
          >
            <TopGainer title="Top Losers" data={loserCard} />
          </div>
        ) : (
          <TopGainerSkeleton title="Top Losers" />
        )}
        {activeHeadline ? (
          <div>
            <TopNews
              title="Top News"
              newsTitle={activeHeadline.newsTitle}
              newsContent={activeHeadline.newsContent}
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
  );
}

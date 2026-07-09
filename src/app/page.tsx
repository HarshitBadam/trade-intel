"use client"

import { StockGraph } from "@/components/StockGraph"
import { Overview } from "@/components/Overview"
import TopGainer from "@/components/TopGainer"
import TopNews from "@/components/TopNews"
import { useParams, useRouter } from "next/navigation";
import { FloatingWidget } from "@/components/FloatingWidget";
import { useState } from "react";
import { SearchBar } from "@/components/SearchBar"
import { mockStockData } from "@/data/mockStocks";
import { StockChips } from "@/components/StockChips";
import { RecentInfluential } from "@/components/RecentInfluential";


const topShifts = [
  { ticker: "AAPL", name: "Apple Inc.", change: "+3.2%", sentiment: "🟢 Bullish (67%)" },
  { ticker: "TSLA", name: "Tesla Inc.", change: "-1.5%", sentiment: "🔴 Bearish (54%)" },
  { ticker: "NVDA", name: "NVIDIA Corporation", change: "+5.1%", sentiment: "🟢 Very Bullish (78%)" },
  { ticker: "AMZN", name: "Amazon.com Inc.", change: "-2.3%", sentiment: "🔴 Bearish (45%)" },
  { ticker: "MSFT", name: "Microsoft Corp.", change: "+4.6%", sentiment: "🟢 Bullish (72%)" },
];

const topLoser = {
  ticker: "TSLA",                     // Stock ticker
  name: "Tesla Inc.",                 // Company name
  currentPrice: "$675.30",             // Current stock price
  priceChange: "-$15.20",              // Absolute price change
  percentageChange: "-2.20%",          // Percentage price change
  volume: "52.3M",                     // Trading volume
  sentiment: "🔴 60% Bearish",         // Sentiment score
  sentimentSource: ["Twitter", "News", "Analyst Reports"], // Sources of sentiment
  reason: "Tesla faces supply chain issues, stock drops",  // Key reason for the price movement
};


const topGainer = {
  ticker: "AAPL",                     // Stock ticker
  name: "Apple Inc.",                 // Company name
  currentPrice: "$180.25",             // Current stock price
  priceChange: "+$8.50",               // Absolute price change
  percentageChange: "+4.95%",          // Percentage price change
  volume: "78.5M",                     // Trading volume
  sentiment: "🟢 75% Bullish",          // Sentiment score
  sentimentSource: ["Twitter", "News", "Analyst Ratings"], // Sources of sentiment
  reason: "Apple announced record iPhone sales",  // Key reason for the price movement
};

const topNews = {
  title: "Breaking Market News",
  newsTitle: "Apple Stock Hits New High Amid Strong iPhone Sales",
  newsContent: 
    "Apple Inc. (AAPL) surged 5% today, reaching an all-time high of $190.50 per share. \
    The rally comes after the company reported record-breaking iPhone sales, exceeding market expectations. \
    Analysts believe Apple's strong earnings and continued demand for its products are driving investor confidence. \
    The stock is now up 15% year-to-date, with bullish sentiment dominating the market.",
};


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

  const handleStockClick = () => {
    router.push(`/details/${currentStock.id}`);
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
              stockPrice={currentStock.stockPrice}
              priceChange={currentStock.priceChange}
              percentChange={currentStock.percentChange}
              chartData={currentStock.chartData}
              hasShuffle={false}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Overview title="Top Sentiment Shifts"/>
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
       

        <div className="cursor-pointer" onClick={handleStockClick}>
          <TopGainer title="Top Gainers" data={topGainer} />
          
        </div>
        <div className="cursor-pointer" onClick={handleStockClick}>
          <TopGainer title="Top Losers" data={topLoser} />
        </div>
        <div>
          <TopNews title="Top News" newsTitle={topNews.newsTitle} newsContent={topNews.newsContent} />
        </div>
      </div>
      <FloatingWidget 
        isExpanded={isWidgetExpanded} 
        onClose={handleWidgetClose}
        onOpen={handleWidgetOpen}
      />
   
    </div>
  )
} 
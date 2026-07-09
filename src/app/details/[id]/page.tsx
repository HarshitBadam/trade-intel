import { getDetailsData } from "@/lib/market-data";
import DetailsView from "./DetailsView";
import { triggerPriorityAnalysis } from "./priority";
import type { News, NewsStatus } from "@/components/news/RecentInfluential";
import type { BarPoint } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";

export type StockData = {
  id: string;
  companyName: string;
  stockPrice: number | undefined;
  priceChange: number;
  percentChange: number;
  /**
   * "live": real Polygon candles. "sample": deterministic demo data (only in
   * the zero-provider build or for invalid tickers). "unavailable": live mode
   * but the fetch failed — the UI shows an honest placeholder and re-polls
   * instead of presenting fabricated prices.
   */
  priceStatus: "live" | "sample" | "unavailable";
  popularityRate: number;
  mentions: number;
  searchVolume: number;
  sentimentPercentage: number;
  positiveSentimentPercentage: number;
  negativeSentimentPercentage: number;
  /**
   * News-bucketed sentiment series (kept for the sentiment math). The popularity
   * view now renders a dense market-activity chart derived from the price bars
   * below, so this field is retained but no longer drives the chart.
   */
  popularitySeries: { date: string; positive: number; negative: number }[];
  popularityStatus: "live" | "sample";
  // Price bars carry optional volume/trades (close = `value`, so the price chart
  // is untouched); the popularity/activity chart reuses them.
  chartData: BarPoint[];
  intradayData?: BarPoint[];
  weekData?: BarPoint[];
  fineData?: BarPoint[];
  news: News[];
  newsStatus: NewsStatus;
  newsUpdatedAt?: string;
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const initial = await getDetailsData(id, triggerPriorityAnalysis);
  return <DetailsView initial={initial} ticker={id} key={id} />;
}

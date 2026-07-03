import { getDetailsData } from "@/lib/market-data";
import DetailsView from "./DetailsView";
import type { News, NewsStatus } from "@/components/news/RecentInfluential";

export const dynamic = "force-dynamic";

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
  const initial = await getDetailsData(id);
  return <DetailsView initial={initial} ticker={id} key={id} />;
}

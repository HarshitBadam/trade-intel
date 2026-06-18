import { mockStockData } from "@/data/mockStocks";
import { getHomeData } from "@/lib/market-data";
import HomeView from "./HomeView";

export const dynamic = "force-dynamic";

export default async function StocksPage() {
  const defaultStock =
    mockStockData.find((s) => s.id === 1) ?? mockStockData[0];
  const initial = await getHomeData(defaultStock.ticker);
  return <HomeView initial={initial} />;
}

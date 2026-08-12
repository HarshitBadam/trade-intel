import { Suspense } from "react";
import { getRelatedStocksData } from "@/lib/market-data/api-related";
import { getDetailsData } from "@/lib/market-data/queries";
import { sanitizeTicker } from "@/lib/market-data/transforms";
import type { StockData } from "@/lib/market-intelligence/types";
import DetailsView from "./DetailsView";
import RelatedStocksSection, {
  RelatedStocksSkeleton,
} from "./RelatedStocksSection";

export const dynamic = "force-dynamic";

export type { StockData } from "@/lib/market-intelligence/types";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const symbol = sanitizeTicker(id);
  const relatedPromise = symbol
    ? getRelatedStocksData(symbol)
    : Promise.resolve([]);
  const initial = await getDetailsData(id);
  return (
    <>
      <DetailsView initial={initial} ticker={id} key={id} />
      <Suspense fallback={<RelatedStocksSkeleton />}>
        <RelatedStocksSection ticker={id} relatedPromise={relatedPromise} />
      </Suspense>
    </>
  );
}

import Link from "next/link";
import TopGainer, {
  TopGainerSkeleton,
} from "@/components/stocks/TopGainer";
import { getRelatedStocksData } from "@/lib/market-data";
import { sanitizeTicker } from "@/lib/market-data/transforms";
import type { RelatedCard } from "@/lib/market-data/types";

export function RelatedStocksSkeleton() {
  return (
    <div className="max-w-[1600px] mx-auto px-8 pb-12">
      <h2 className="text-xl font-semibold mb-4 text-start">Related Stocks</h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, index) => (
          <TopGainerSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

export default async function RelatedStocksSection({
  ticker,
  relatedPromise,
}: {
  ticker: string;
  relatedPromise?: Promise<RelatedCard[]>;
}) {
  const symbol = sanitizeTicker(ticker);
  if (!symbol) return null;
  const related = await (
    relatedPromise ?? getRelatedStocksData(symbol)
  ).catch(() => []);
  if (related.length === 0) return null;

  return (
    <section className="max-w-[1600px] mx-auto px-8 pb-12">
      <h2 className="text-xl font-semibold mb-4 text-start">Related Stocks</h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {related.map(({ title, data }) => (
          <Link
            key={data.ticker}
            href={`/details/${data.ticker}`}
            prefetch
            className="block"
          >
            <TopGainer title={title} data={data} />
          </Link>
        ))}
      </div>
    </section>
  );
}

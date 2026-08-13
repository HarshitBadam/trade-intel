import { Search } from "lucide-react";
import { TopGainerSkeleton } from "@/components/stocks/TopGainer";
import { ChartCardSkeleton, SentimentPanelSkeleton } from "./DetailsSkeletons";

function SearchBarSkeleton() {
  return (
    <div className="relative w-full shadow-md rounded-lg glass-card">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <div className="w-full select-none rounded-lg bg-background px-10 py-2 text-sm text-muted-foreground dark:bg-transparent">
        Search for stocks
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="min-h-screen">
      <div className="max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 p-8">
            <div className="space-y-6">
              <SearchBarSkeleton />
              <div className="mt-8 h-[600px]">
                <ChartCardSkeleton />
              </div>
            </div>
          </div>

          <div className="lg:col-span-4 relative">
            <div className="p-8 lg:pl-0 lg:absolute lg:inset-0">
              <SentimentPanelSkeleton />
            </div>
          </div>

          <div className="lg:col-span-12">
            <div className="px-8 pb-12">
              <h2 className="text-xl font-semibold mb-4 text-start">
                Related Stocks
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <TopGainerSkeleton key={i} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

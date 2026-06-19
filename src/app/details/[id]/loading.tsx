import { Search } from "lucide-react";
import { TopGainerSkeleton } from "@/components/TopGainer";

/* Route-level loading UI. Next.js renders this instantly during the client
   navigation transition while the dynamic page (`await getDetailsData`) renders
   on the server — so clicking a stock redirects immediately and this skeleton
   pops in, instead of the user being stuck on the previous page. Mirrors the
   real DetailsView grid so the layout doesn't shift when data arrives. */

function SearchBarSkeleton() {
  return (
    <div className="relative w-full shadow-md rounded-lg glass-card">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <div className="w-full select-none rounded-lg bg-background px-10 py-2 text-sm text-muted-foreground dark:bg-transparent">
        Search for stocks...
      </div>
    </div>
  );
}

function ChartCardSkeleton() {
  return (
    <div className="w-full h-full shadow-md bg-accent/10 glass-card rounded-lg flex flex-col animate-pulse">
      <div className="p-8 space-y-4">
        <div className="h-7 w-40 rounded bg-muted" />
        <div className="flex items-baseline gap-3">
          <div className="h-9 w-32 rounded bg-muted" />
          <div className="h-4 w-28 rounded bg-muted" />
        </div>
        <div className="flex gap-1 pt-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-6 w-9 rounded-md bg-muted" />
          ))}
        </div>
      </div>
      <div className="flex-1 px-8 pb-8">
        <div className="h-full w-full rounded-lg bg-muted/50" />
      </div>
    </div>
  );
}

function SentimentPanelSkeleton() {
  return (
    <div className="w-full rounded-lg p-6 glass-card shadow-md flex flex-col h-full animate-pulse">
      <div className="pb-8 space-y-4">
        <div className="h-6 w-48 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
      </div>
      <div className="pb-8 space-y-3">
        <div className="h-6 w-44 rounded bg-muted" />
        <div className="h-8 w-full rounded bg-muted" />
      </div>
      <div className="space-y-4">
        <div className="h-6 w-40 rounded bg-muted" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-4">
            <div className="h-10 w-10 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/2 rounded bg-muted" />
              <div className="h-3 w-full rounded bg-muted" />
            </div>
          </div>
        ))}
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

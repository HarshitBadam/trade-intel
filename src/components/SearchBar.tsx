"use client";

import { Search } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { searchStocks } from "@/app/details/[id]/actions";
import type { SearchResult } from "@/lib/market-data-types";

export function SearchBar() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Debounced search to avoid excessive API calls. The `cancelled` flag makes
  // this "latest-wins": when the query changes (fast typing / paste) the prior
  // run is cancelled so a slower, stale in-flight request can't resolve later
  // and clobber the newest results with empty/partial ones.
  useEffect(() => {
    if (searchQuery.trim().length === 0) {
      setSearchResults([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const fetchSearchResults = async () => {
      setIsLoading(true);
      try {
        const results = await searchStocks(searchQuery);
        if (!cancelled) setSearchResults(results);
      } catch (error) {
        if (!cancelled) {
          console.error("Error searching stocks:", error);
          setSearchResults([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    const debounceTimer = setTimeout(fetchSearchResults, 300);
    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [searchQuery]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleStockClick = (ticker: string) => {
    setShowResults(false);
    setSearchQuery("");
    router.push(`/details/${ticker}`);
  };

  // The OUTER wrapper is a plain `position: relative` box with NO
  // backdrop-filter, so it never becomes a stacking context. That's what lets
  // the dropdown's z-50 resolve against the page root (above the sibling cards)
  // in BOTH themes. The frosted glass + focus glow live on the INNER row, so
  // dark mode behaves exactly like light mode. Putting `glass-card` on the outer
  // element would add a dark-only backdrop-filter and trap the dropdown behind
  // the cards — which was the original bug.
  return (
    <div className="relative w-full" ref={searchRef}>
      <div className="relative w-full shadow-md rounded-lg glass-card siri-focus">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowResults(true);
          }}
          placeholder="Search for stocks..."
          className="w-full rounded-lg bg-background dark:bg-transparent px-10 py-2 text-sm outline-none focus:outline-none"
        />
      </div>

      {showResults && searchQuery && (
        <div className="absolute top-full left-0 right-0 mt-2 p-1.5 bg-popover text-popover-foreground border border-border rounded-xl shadow-xl max-h-[320px] overflow-y-auto z-50">
          {isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Searching…
            </div>
          ) : searchResults.length > 0 ? (
            searchResults.map((stock) => (
              <button
                key={stock.ticker}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                onClick={() => handleStockClick(stock.ticker)}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-accent text-[11px] font-semibold text-foreground/80">
                  {stock.ticker.slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {stock.name}
                </span>
                <span className="shrink-0 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-muted-foreground">
                  {stock.ticker}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No stocks found
            </div>
          )}
        </div>
      )}
    </div>
  );
}

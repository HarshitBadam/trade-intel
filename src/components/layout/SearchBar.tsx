"use client";

import { Search } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { searchStocks } from "@/app/details/[id]/actions";
import type { SearchResult } from "@/lib/market-data/types";

const NAME_NOISE_WORDS = new Set([
  "inc",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "plc",
  "group",
  "holding",
  "holdings",
  "class",
  "common",
  "ordinary",
  "stock",
  "shares",
  "warrants",
  "adr",
]);

function stockInitials(name: string, ticker: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z]/g, ""))
    .filter((word) => word && !NAME_NOISE_WORDS.has(word.toLowerCase()));

  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return ticker.slice(0, 2).toUpperCase();
}

export function SearchBar() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (searchQuery.trim().length === 0) {
      setSearchResults([]);
      setSearchFailed(false);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const fetchSearchResults = async () => {
      setIsLoading(true);
      try {
        const { stocks, searchUnavailable } = await searchStocks(searchQuery);
        if (cancelled) return;
        setSearchResults(stocks);
        setSearchFailed(searchUnavailable === true);
        setIsLoading(false);
      } catch (error) {
        if (!cancelled) {
          console.error("Error searching stocks:", error);
          setSearchResults([]);
          setSearchFailed(true);
          setIsLoading(false);
        }
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

  return (
    <div className="relative w-full" ref={searchRef}>
      <div
        className="relative w-full rounded-lg glass-card siri-focus"
        style={{
          boxShadow:
            "4px 3px 9px -3px rgba(0, 0, 0, 0.13), 1px 2px 4px -2px rgba(0, 0, 0, 0.1)",
        }}
      >
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowResults(true);
          }}
          placeholder="Search for stocks"
          className="w-full rounded-lg bg-background dark:bg-transparent px-10 py-2.5 text-sm outline-none focus:outline-none"
        />
      </div>

      {showResults && searchQuery && (
        <div className="absolute top-full left-0 right-0 mt-2 p-2 bg-white dark:bg-card/85 dark:backdrop-blur-xl text-popover-foreground border border-black/[0.08] dark:border-white/10 rounded-2xl shadow-[0_16px_40px_-12px_rgba(0,0,0,0.18),0_4px_12px_-6px_rgba(0,0,0,0.08)] dark:shadow-2xl max-h-[320px] overflow-y-auto z-50">
          {isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Searching.
            </div>
          ) : searchResults.length > 0 ? (
            searchResults.map((stock) => (
              <button
                key={stock.ticker}
                type="button"
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                onClick={() => handleStockClick(stock.ticker)}
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 select-none items-center justify-center rounded-md text-[11px] font-medium tracking-wide bg-muted text-muted-foreground"
                >
                  {stockInitials(stock.name, stock.ticker)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {stock.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] font-medium tracking-widest text-muted-foreground/80">
                  {stock.ticker}
                </span>
              </button>
            ))
          ) : searchFailed ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Search is temporarily unavailable, try again in a moment
            </div>
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

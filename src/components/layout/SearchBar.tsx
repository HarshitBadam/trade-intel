"use client";

import { Search } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { searchStocks, checkSearchChartable } from "@/app/details/[id]/actions";
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
  // Populated a moment after results land, once the background chartability
  // check (see below) comes back. Entries in here fade to a disabled state
  // IN PLACE rather than being removed from the list — removing them would
  // reflow/shift every row below and could yank an item out from under a
  // user who's mid-click. This way nothing moves; the rare (~2.7%) dead
  // ticker just stops being clickable a second later.
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (searchQuery.trim().length === 0) {
      setSearchResults([]);
      setUnavailable(new Set());
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const fetchSearchResults = async () => {
      setIsLoading(true);
      setUnavailable(new Set());
      try {
        const results = await searchStocks(searchQuery);
        if (cancelled) return;
        setSearchResults(results);
        setIsLoading(false);

        // Non-blocking follow-up: verify which results are actually chartable
        // and mark the rare (~2.7%) dead end unavailable a moment later,
        // instead of holding up the whole dropdown for a check that's ~3x
        // slower than the search itself. Never re-triggers "Searching…", and
        // never removes a row (see the `unavailable` state comment above).
        if (results.length > 0) {
          checkSearchChartable(results.map((r) => r.ticker))
            .then((chartable) => {
              if (cancelled) return;
              const ok = new Set(chartable.map((t) => t.toUpperCase()));
              const bad = results
                .map((r) => r.ticker.toUpperCase())
                .filter((t) => !ok.has(t));
              if (bad.length > 0) setUnavailable(new Set(bad));
            })
            .catch(() => {
              // Best-effort only — leave everything clickable if the check fails.
            });
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Error searching stocks:", error);
          setSearchResults([]);
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
    if (unavailable.has(ticker.toUpperCase())) return;
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
          placeholder="Search for stocks..."
          className="w-full rounded-lg bg-background dark:bg-transparent px-10 py-2.5 text-sm outline-none focus:outline-none"
        />
      </div>

      {showResults && searchQuery && (
        <div className="absolute top-full left-0 right-0 mt-2 p-2 bg-white dark:bg-card/85 dark:backdrop-blur-xl text-popover-foreground border border-black/[0.08] dark:border-white/10 rounded-2xl shadow-[0_16px_40px_-12px_rgba(0,0,0,0.18),0_4px_12px_-6px_rgba(0,0,0,0.08)] dark:shadow-2xl max-h-[320px] overflow-y-auto z-50">
          {isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Searching…
            </div>
          ) : searchResults.length > 0 ? (
            searchResults.map((stock) => {
              const isUnavailable = unavailable.has(stock.ticker.toUpperCase());
              return (
                <button
                  key={stock.ticker}
                  type="button"
                  disabled={isUnavailable}
                  aria-disabled={isUnavailable}
                  title={isUnavailable ? "Chart data isn't available for this ticker" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-[opacity,background-color] duration-300 focus:outline-none ${
                    isUnavailable
                      ? "opacity-40 cursor-not-allowed"
                      : "cursor-pointer hover:bg-accent focus:bg-accent"
                  }`}
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
              );
            })
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

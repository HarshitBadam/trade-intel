"use client";

import { Search } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { searchStocks, SearchResult } from "@/app/details/[id]/actions";

export function SearchBar() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Debounced search to avoid excessive API calls
  useEffect(() => {
    if (searchQuery.length === 0) {
      setSearchResults([]);
      return;
    }

    const fetchSearchResults = async () => {
      setIsLoading(true);
      try {
        const results = await searchStocks(searchQuery);
        setSearchResults(results);
      } catch (error) {
        console.error("Error searching stocks:", error);
        setSearchResults([]);
      } finally {
        setIsLoading(false);
      }
    };

    const debounceTimer = setTimeout(fetchSearchResults, 300); // Debounce API call
    return () => clearTimeout(debounceTimer);
  }, [searchQuery]);

  // Handle click outside to close results dropdown
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
    <div className="relative w-full shadow-md rounded-lg glass-card siri-focus" ref={searchRef}>
      <div className="relative">
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

      {/* Search Results Dropdown */}
      {showResults && searchQuery && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-background border border-accent/20 glass-panel rounded-lg shadow-lg max-h-[300px] overflow-y-auto z-50">
          {isLoading ? (
            <div className="px-4 py-2 text-muted-foreground">Loading...</div>
          ) : searchResults.length > 0 ? (
            searchResults.map((stock) => (
              <div
                key={stock.ticker}
                className="px-4 py-2 hover:bg-accent/70 cursor-pointer transition-colors"
                onClick={() => handleStockClick(stock.ticker)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{stock.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {stock.ticker}
                    </div>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="px-4 py-2 text-muted-foreground">No stocks found</div>
          )}
        </div>
      )}
    </div>
  );
}

"use client"

import { Overview } from "@/components/Overview"
import TopGainer from "@/components/TopGainer"
import TopNews from "@/components/TopNews"
import Image from "next/image"
import { useRouter } from "next/navigation"


export default function StocksPage() {
  const router = useRouter();

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Stock Analysis</h1>
        <p className="text-muted-foreground">Track and analyze stock performance with real-time data.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* First row */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xl font-bold">Trending Now</div>
            <div 
              className="flex items-center gap-2 cursor-pointer hover:text-foreground transition-colors"
              onClick={() => router.push('/detail')}
            >
              <Image 
                src="/shuffle.svg" 
                alt="reshuffle" 
                width={16}
                height={16}
                className="text-muted-foreground hover:text-foreground transition-colors"
              />
              <div className="text-xs text-muted-foreground">Reshuffle</div>
            </div>
          </div>
          <div>watchlist</div>
        </div>
        {/* ... rest of your components ... */}
      </div>
    </div>
  )
} 
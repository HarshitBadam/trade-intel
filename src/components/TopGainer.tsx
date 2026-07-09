interface TopGainerInfo {
  ticker: string;
  name: string;
  currentPrice: string;
  priceChange: string;
  percentageChange: string;
  volume: string;
  sentiment: string;
  sentimentSource: string[];
  reason: string;
}

interface TopGainerProps {
  title: string;
  data: TopGainerInfo;
}

export default function TopGainer({ title, data }: TopGainerProps) {
    return (
      <div className="rounded-lg p-6 h-full bg-card shadow-md cursor-pointer">
        {/* Title */}
        <h2 className="text-xl font-semibold mb-4">{title}</h2>
        
        <div className="space-y-6">
          {/* Header with ticker and current price */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-2xl font-bold">{data.ticker}</h3>
              <p className="text-sm text-muted-foreground">{data.name}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{data.currentPrice}</p>
              <div className="flex items-center gap-2">
                <span
                  className={title === "Top Losers" ? "text-red-500" : "text-green-500"}
                >
                  {data.priceChange}
                </span>
                <span
                  className={title === "Top Losers" ? "text-red-500" : "text-green-500"}
                >
                  {data.percentageChange}
                </span>
              </div>
            </div>
          </div>
  
          {/* Volume */}
          <div className="flex items-center justify-between py-2 border-t">
            <span className="text-sm text-muted-foreground">Volume</span>
            <span className="font-medium">{data.volume}</span>
          </div>
  
          {/* Sentiment */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Sentiment</span>
              <span className="font-medium">{data.sentiment}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {data.sentimentSource.map((source) => (
                <span key={source} className="text-xs bg-muted px-2 py-1 rounded-full">
                  {source}
                </span>
              ))}
            </div>
          </div>
  
          {/* Reason */}
          <div className="pt-2 border-t">
            <p className="text-sm text-muted-foreground">Key Reason</p>
            <p className="text-sm mt-1">{data.reason}</p>
          </div>
        </div>
      </div>
    );
  }
  
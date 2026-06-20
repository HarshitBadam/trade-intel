import { SentimentLabel } from "./SentimentLabel";

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
    // Colour by the actual move (sign of the % change), not the card title, so
    // a "Same Sector" peer that's down shows red and one that's up shows green.
    const negative = data.percentageChange.trim().startsWith("-");
    const changeColor = negative ? "text-red-500" : "text-green-500";
    return (
      <div className="rounded-lg p-6 h-full bg-card glass-card shadow-md cursor-pointer">
        <h2 className="text-xl font-semibold mb-4">{title}</h2>
        
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-2xl font-bold">{data.ticker}</h3>
              <p className="text-sm text-muted-foreground">{data.name}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{data.currentPrice}</p>
              <div className="flex items-center gap-2">
                <span className={changeColor}>{data.priceChange}</span>
                <span className={changeColor}>{data.percentageChange}</span>
              </div>
            </div>
          </div>
  
          <div className="flex items-center justify-between py-2 border-t">
            <span className="text-sm text-muted-foreground">Volume</span>
            <span className="font-medium">{data.volume}</span>
          </div>
  
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Sentiment</span>
              <SentimentLabel sentiment={data.sentiment} className="font-medium text-sm" />
            </div>
            <div className="flex flex-wrap gap-2">
              {data.sentimentSource.map((source) => (
                <span key={source} className="text-xs bg-muted px-2 py-1 rounded-full">
                  {source}
                </span>
              ))}
            </div>
          </div>
  
          <div className="pt-2 border-t">
            <p className="text-sm text-muted-foreground">Key Reason</p>
            <p className="text-sm mt-1">{data.reason}</p>
          </div>
        </div>
      </div>
    );
  }

export function TopGainerSkeleton({ title }: { title?: string }) {
  return (
    <div className="rounded-lg p-6 h-full bg-card glass-card shadow-md animate-pulse">
      {title ? (
        <h2 className="text-xl font-semibold mb-4">{title}</h2>
      ) : (
        <div className="h-6 w-32 rounded bg-muted mb-4" />
      )}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-7 w-20 rounded bg-muted" />
            <div className="h-3 w-28 rounded bg-muted" />
          </div>
          <div className="space-y-2 text-right">
            <div className="h-7 w-24 rounded bg-muted ml-auto" />
            <div className="h-3 w-20 rounded bg-muted ml-auto" />
          </div>
        </div>
        <div className="h-4 w-full rounded bg-muted pt-2" />
        <div className="space-y-2">
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-6 w-2/3 rounded bg-muted" />
        </div>
        <div className="h-10 w-full rounded bg-muted pt-2" />
      </div>
    </div>
  );
}

import { useRouter } from "next/navigation";
import { SentimentLabel } from "./SentimentLabel";

export type Shift = {
  ticker: string;
  name: string;
  change: string;
  sentiment: string;
};

interface OverviewProps {
  title: string;
  shifts?: Shift[];
  children?: React.ReactNode;
}

export const topShifts: Shift[] = [
  { ticker: "AAPL", name: "Apple Inc.", change: "+3.2%", sentiment: "Bullish (67%)" },
  { ticker: "TSLA", name: "Tesla Inc.", change: "-1.5%", sentiment: "Bearish (54%)" },
  { ticker: "NVDA", name: "NVIDIA Corporation", change: "+5.1%", sentiment: "Very Bullish (78%)" },
];

export function Overview({ title, shifts = topShifts, children }: OverviewProps) {
  const router = useRouter();

  const handleStockClick = (ticker: string) => {
    router.push(`/details/${ticker}`);
  };

  return (
    <div className="rounded-lg p-6 h-full bg-card glass-card shadow-md">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <div className="space-y-4">
        {shifts.map((shift, index) => (
          <div 
            key={shift.ticker} 
            className="flex cursor-pointer flex-col space-y-1 p-2 hover:bg-muted/50 rounded-lg transition-colors" 
            onClick={() => handleStockClick(shift.ticker)}
          >
            <div className="flex items-center w-full">
              <span className="text-sm text-muted-foreground w-6">{index + 1}.</span>
              <div className="flex items-center justify-between flex-1">
                <h3 className="font-medium">{shift.ticker}</h3>
                <span className={shift.change.startsWith('+') ? 'text-green-500' : 'text-red-500'}>
                  {shift.change}
                </span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground pl-6">{shift.name}</p>
            <SentimentLabel sentiment={shift.sentiment} className="text-sm pl-6" />
          </div>
        ))}
      </div>
    </div>
  );
} 
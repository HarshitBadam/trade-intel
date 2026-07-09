"use client"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

interface BarProps {
  segments: {
    percentage: number;
    color: string;
    sentiment: string;
  }[];
  height?: string;
  className?: string;
}

export function Bar({ segments, height = "h-3", className = "" }: BarProps) {

  // Validate that percentages sum to 100
  const totalPercentage = segments.reduce((sum, segment) => sum + segment.percentage, 0);
  if (totalPercentage !== 100) {
    console.warn('Bar segments percentages should sum to 100');
  }

  return (
    <div className={`w-full ${height} flex overflow-hidden ${className}`}>
      {segments.map((segment, index) => (
        <HoverCard openDelay={0.5} closeDelay={0.5} key={index}>
          <HoverCardTrigger asChild>
            <div
            key={index}
            className={`${segment.color}`}
            style={{ width: `${segment.percentage}%` }}
          />
          </HoverCardTrigger>
          <HoverCardContent className="w-30 p-4">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium">{"Sentiment: " + segment.sentiment}</p>
              <p className="text-xs text-muted-foreground">{"Percentage: " + segment.percentage}%</p>
            </div>
          </HoverCardContent>
        </HoverCard>
        
      ))}
      
      
    </div>
  );
} 
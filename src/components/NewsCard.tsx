"use client"
import { CalendarDays } from "lucide-react"
import Image from "next/image"
import { useChart } from "@/context/ChartContext"
import { useEffect, useState } from "react"

interface NewsCardProps {
  id: string;
  username: string;
  content: string;
  date: string;  // Format: YYYY-MM-DD to match with the chart data
  significance: string; //use LOW, MEDIUM, HIGH
  avatarUrl: string;
  source: string;
}

export function NewsCard({ id, username, content, date, avatarUrl, significance, source }: NewsCardProps) {
  const { hoveredTimestamp, setHoveredTimestamp } = useChart();
  const [currentlyHovered, setCurrentlyHovered] = useState<string | null>(null);
  // Format the display date for UI
  // const formatDisplayDate = (dateStr: string) => {
  //   const formattedDate = new Date(dateStr);
  //   return formattedDate.toLocaleDateString("en-US", {
  //     month: "short",
  //     day: "numeric",
  //     year: "numeric",
  //   });
  // };


  return (
    <div 
      className={`flex items-start space-x-4 rounded-lg shadow-sm p-4 ${
        currentlyHovered === id ? 'bg-accent/40' : ''
      }`} 
      onMouseEnter={() => {
        setHoveredTimestamp(date);  // This will be in YYYY-MM-DD format
        setCurrentlyHovered(id);
      }} 
      onMouseLeave={() => {
        setHoveredTimestamp(null);
        setCurrentlyHovered(null);
      }}
    >
      
      {avatarUrl ? (
        <Image
          src={avatarUrl}
          alt={`${username}'s avatar`}
          width={40}
          height={40}
          className="rounded-full"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
          <span className="text-sm font-medium text-muted-foreground">
            {username.charAt(1).toUpperCase()}
          </span>
        </div>
      )}
      <div className="flex-1 space-y-1">
        <div className="flex justify-between items-center gap-2">
          <p className="text-sm font-medium">{username}</p>
          <div className={`h-2 w-2 rounded-full ${significance === "LOW" ? "bg-green-500" : significance === "MEDIUM" ? "bg-yellow-500" : "bg-red-500"}`}></div>
        </div>
        <p className="text-sm text-muted-foreground">{content}</p>
        <div className="flex items-center gap-2 text-muted-foreground mt-3">
          <CalendarDays className="h-4 w-4" />
          <span className="text-xs">{date}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold">{source}</span>
          </div>
          
        </div>
      </div>
    </div>
  )
} 
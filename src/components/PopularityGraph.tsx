"use client"
import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PopularityChart } from "./PopularityChart"

interface PopularityGraphProps {
  companyName: string;
  popularityRate: number;
  mentions: number;
  searchVolume: number;
  sentimentPercentage: number;
}

export function PopularityGraph({
  companyName,
  popularityRate,
  mentions,
  searchVolume,
  sentimentPercentage
}: PopularityGraphProps) {
  return (
    <div className="w-full shadow-md bg-accent/10 rounded-lg flex flex-col">

      <div className="flex justify-between">
        <div className="stock-text-description-left p-8">
          <h2 className="text-2xl font-bold">{companyName}</h2>
          <span className="text-3xl font-bold">{popularityRate}</span>
          <div className="flex flex-colitems-baseline gap-4 mt-1">
            <div className="text-muted-foreground text-sm">Mentions: {mentions} Today</div>
            <div className="text-muted-foreground text-sm">Search Volume: {10}</div>
            <div className="text-muted-foreground text-sm">{sentimentPercentage} Positive Sentiment</div>
          </div>
        </div>

        <div className="flex pt-10 pr-5">
          <img src="/shuffle.svg" alt="shuffle" className="w-4 h-4 mr-2" />
          <div className="stock-text-description-right text-light text-gray-500 text-xs ">Switch to Stock Price View</div>
        </div>
      </div>
      
      <PopularityChart />
    </div>
  )
} 
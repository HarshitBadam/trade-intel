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

const chartData = [
  { date: "2024-04-01", negative: 222, positive: 150 },
  { date: "2024-04-02", negative: 97, positive: 180 },
  { date: "2024-04-03", negative: 167, positive: 120 },
  { date: "2024-04-04", negative: 242, positive: 260 },
  { date: "2024-04-05", negative: 373, positive: 290 },
  { date: "2024-04-06", negative: 301, positive: 340 },
  { date: "2024-04-07", negative: 245, positive: 180 },
  { date: "2024-04-08", negative: 409, positive: 320 },
  { date: "2024-04-09", negative: 59, positive: 110 },
  { date: "2024-04-10", negative: 261, positive: 190 },
  { date: "2024-04-11", negative: 327, positive: 350 },
  { date: "2024-04-12", negative: 292, positive: 210 },
  { date: "2024-04-13", negative: 342, positive: 380 },
  { date: "2024-04-14", negative: 137, positive: 220 },
  { date: "2024-04-15", negative: 120, positive: 170 },
  { date: "2024-04-16", negative: 138, positive: 190 },
  { date: "2024-04-17", negative: 446, positive: 360 },
  { date: "2024-04-18", negative: 364, positive: 410 },
  { date: "2024-04-19", negative: 243, positive: 180 },
  { date: "2024-04-20", negative: 89, positive: 150 },
  { date: "2024-04-21", negative: 137, positive: 200 },
  { date: "2024-04-22", negative: 224, positive: 170 },
  { date: "2024-04-23", negative: 138, positive: 230 },
  { date: "2024-04-24", negative: 387, positive: 290 },
  { date: "2024-04-25", negative: 215, positive: 250 },
  { date: "2024-04-26", negative: 75, positive: 130 },
  { date: "2024-04-27", negative: 383, positive: 420 },
  { date: "2024-04-28", negative: 122, positive: 180 },
  { date: "2024-04-29", negative: 315, positive: 240 },
  { date: "2024-04-30", negative: 454, positive: 380 },
  { date: "2024-05-01", negative: 165, positive: 220 },
  { date: "2024-05-02", negative: 293, positive: 310 },
  { date: "2024-05-03", negative: 247, positive: 190 },
  { date: "2024-05-04", negative: 385, positive: 420 },
  { date: "2024-05-05", negative: 481, positive: 390 },
  { date: "2024-05-06", negative: 498, positive: 520 },
  { date: "2024-05-07", negative: 388, positive: 300 },
  { date: "2024-05-08", negative: 149, positive: 210 },
  { date: "2024-05-09", negative: 227, positive: 180 },
  { date: "2024-05-10", negative: 293, positive: 330 },
  { date: "2024-05-11", negative: 335, positive: 270 },
  { date: "2024-05-12", negative: 197, positive: 240 },
  { date: "2024-05-13", negative: 197, positive: 160 },
  { date: "2024-05-14", negative: 448, positive: 490 },
  { date: "2024-05-15", negative: 473, positive: 380 },
  { date: "2024-05-16", negative: 338, positive: 400 },
  { date: "2024-05-17", negative: 499, positive: 420 },
  { date: "2024-05-18", negative: 315, positive: 350 },
  { date: "2024-05-19", negative: 235, positive: 180 },
  { date: "2024-05-20", negative: 177, positive: 230 },
  { date: "2024-05-21", negative: 82, positive: 140 },
  { date: "2024-05-22", negative: 81, positive: 120 },
  { date: "2024-05-23", negative: 252, positive: 290 },
  { date: "2024-05-24", negative: 294, positive: 220 },
  { date: "2024-05-25", negative: 201, positive: 250 },
  { date: "2024-05-26", negative: 213, positive: 170 },
  { date: "2024-05-27", negative: 420, positive: 460 },
  { date: "2024-05-28", negative: 233, positive: 190 },
  { date: "2024-05-29", negative: 78, positive: 130 },
  { date: "2024-05-30", negative: 340, positive: 280 },
  { date: "2024-05-31", negative: 178, positive: 230 },
  { date: "2024-06-01", negative: 178, positive: 200 },
  { date: "2024-06-02", negative: 470, positive: 410 },
  { date: "2024-06-03", negative: 103, positive: 160 },
  { date: "2024-06-04", negative: 439, positive: 380 },
  { date: "2024-06-05", negative: 88, positive: 140 },
  { date: "2024-06-06", negative: 294, positive: 250 },
  { date: "2024-06-07", negative: 323, positive: 370 },
  { date: "2024-06-08", negative: 385, positive: 320 },
  { date: "2024-06-09", negative: 438, positive: 480 },
  { date: "2024-06-10", negative: 155, positive: 200 },
  { date: "2024-06-11", negative: 92, positive: 150 },
  { date: "2024-06-12", negative: 492, positive: 420 },
  { date: "2024-06-13", negative: 81, positive: 130 },
  { date: "2024-06-14", negative: 426, positive: 380 },
  { date: "2024-06-15", negative: 307, positive: 350 },
  { date: "2024-06-16", negative: 371, positive: 310 },
  { date: "2024-06-17", negative: 475, positive: 520 },
  { date: "2024-06-18", negative: 107, positive: 170 },
  { date: "2024-06-19", negative: 341, positive: 290 },
  { date: "2024-06-20", negative: 408, positive: 450 },
  { date: "2024-06-21", negative: 169, positive: 210 },
  { date: "2024-06-22", negative: 317, positive: 270 },
  { date: "2024-06-23", negative: 480, positive: 530 },
  { date: "2024-06-24", negative: 132, positive: 180 },
  { date: "2024-06-25", negative: 141, positive: 190 },
  { date: "2024-06-26", negative: 434, positive: 380 },
  { date: "2024-06-27", negative: 448, positive: 490 },
  { date: "2024-06-28", negative: 149, positive: 200 },
  { date: "2024-06-29", negative: 103, positive: 160 },
  { date: "2024-06-30", negative: 446, positive: 400 },
]

const chartConfig = {
  visitors: {
    label: "Visitors",
  },
  negative: {
    label: "  Negative",
    color: "hsl(var(--chart-1))",
  },
  positive: {
    label: "  Positive",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig

export function PopularityChart() {
  const [timeRange, setTimeRange] = React.useState("90d")

  const filteredData = chartData.filter((item) => {
    const date = new Date(item.date)
    const referenceDate = new Date("2024-06-30")
    let daysToSubtract = 90
    if (timeRange === "30d") {
      daysToSubtract = 30
    } else if (timeRange === "7d") {
      daysToSubtract = 7
    }
    const startDate = new Date(referenceDate)
    startDate.setDate(startDate.getDate() - daysToSubtract)
    return date >= startDate
  })

  return (
    <Card className="outline-1 outline-gray-200 rounded-lg">
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] w-full"
        >
          <AreaChart data={filteredData}>
            <defs>
              <linearGradient id="fillNegative" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="rgba(255, 0, 0, 0.8)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="rgba(255, 0, 0, 0.1)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillPositive" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="rgba(0, 255, 0, 0.8)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="rgba(0, 255, 0, 0.1)"
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                const date = new Date(value)
                return date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })
              }}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => {
                    return new Date(value).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  }}
                  indicator="dot"
                />
              }
            />
            <Area
              dataKey="positive"
              type="natural"
              fill="url(#fillPositive)"
              stroke="rgb(86, 149, 86)"
              strokeWidth={1}
              stackId="a"
            />
            <Area
              dataKey="negative"
              type="natural"
              fill="url(#fillNegative)"
              stroke="rgb(206, 19, 19)"
              strokeWidth={1}
              stackId="a"
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

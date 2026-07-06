"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

import { innerGridLines } from "@/components/charts/grid"
import {
  Card,
  CardContent,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"

const chartConfig = {
  visitors: {
    label: "Visitors",
  },
  negative: {
    label: "  Negative",
    theme: { light: "#94a3b8", dark: "#8b8b93" },
  },
  positive: {
    label: "  Positive",
    theme: { light: "#0369a1", dark: "#409cff" },
  },
} satisfies ChartConfig

export function PopularityChart({
  series,
  rangeDays = 90,
}: {
  series: { date: string; positive: number; negative: number }[]
  rangeDays?: number
}) {
  const filteredData = React.useMemo(() => {
    if (rangeDays === Infinity) return series
    const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000
    return series.filter((item) => new Date(item.date).getTime() >= cutoff)
  }, [series, rangeDays])

  return (
    <Card className="border-0 shadow-none bg-transparent rounded-lg">
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] w-full"
        >
          <AreaChart data={filteredData}>
            <defs>
              <linearGradient id="fillNegative" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" style={{ stopColor: "var(--color-negative)", stopOpacity: 0.3 }} />
                <stop offset="95%" style={{ stopColor: "var(--color-negative)", stopOpacity: 0.03 }} />
              </linearGradient>
              <linearGradient id="fillPositive" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" style={{ stopColor: "var(--color-positive)", stopOpacity: 0.3 }} />
                <stop offset="95%" style={{ stopColor: "var(--color-positive)", stopOpacity: 0.03 }} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              horizontalCoordinatesGenerator={({ offset }) =>
                innerGridLines(offset?.top ?? 0, offset?.height ?? 0, 4)
              }
            />
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
              type="linear"
              fill="url(#fillPositive)"
              stroke="var(--color-positive)"
              strokeWidth={1}
              stackId="a"
            />
            <Area
              dataKey="negative"
              type="linear"
              fill="url(#fillNegative)"
              stroke="var(--color-negative)"
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

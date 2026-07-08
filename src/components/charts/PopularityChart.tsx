"use client"

import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  XAxis,
  YAxis,
} from "recharts"

import { innerGridLines } from "@/components/charts/grid"
import { DAY_MS } from "@/components/charts/ranges"
import { Card, CardContent } from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import { buildActivitySeries } from "@/lib/market-data/transforms"
import type { BarPoint } from "@/lib/market-data/types"
import type { News } from "@/components/news/RecentInfluential"

// Sentiment is encoded as color, matching the gauge's green/red framing. The
// vars are themed via ChartContainer so light/dark both look right.
const chartConfig = {
  activity: { label: "Activity" },
  positive: { label: "Positive", theme: { light: "#16a34a", dark: "#22c55e" } },
  neutral: { label: "Neutral", theme: { light: "#64748b", dark: "#94a3b8" } },
  negative: { label: "Negative", theme: { light: "#dc2626", dark: "#f87171" } },
} satisfies ChartConfig

// A little dead-band around zero keeps the tint from flickering to green/red on
// a barely-net day; those read as neutral.
function sentimentColor(sentiment: number): string {
  if (sentiment > 0.15) return "var(--color-positive)"
  if (sentiment < -0.15) return "var(--color-negative)"
  return "var(--color-neutral)"
}

function sentimentLabel(sentiment: number): string {
  if (sentiment > 0.15) return "Positive"
  if (sentiment < -0.15) return "Negative"
  return "Neutral"
}

type ActivityDatum = { date: number; activity: number; sentiment: number }

function ActivityTooltip({
  active,
  payload,
  metric,
  subDaily,
}: {
  active?: boolean
  payload?: { payload: ActivityDatum }[]
  metric: "trades" | "volume"
  subDaily: boolean
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const dt = new Date(p.date)
  if (Number.isNaN(dt.getTime())) return null
  const label = subDaily
    ? dt.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : dt.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
  const metricLabel = metric === "trades" ? "Trades" : "Volume"
  return (
    <div className="border-border/50 bg-background grid min-w-[9rem] gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="flex items-center justify-between gap-4 text-muted-foreground">
        <span>{metricLabel}</span>
        <span className="text-foreground font-mono tabular-nums">
          {Math.round(p.activity).toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between gap-4 text-muted-foreground">
        <span>News sentiment</span>
        <span className="text-foreground">{sentimentLabel(p.sentiment)}</span>
      </div>
    </div>
  )
}

export function PopularityChart({
  bars,
  news,
  rangeDays = 365,
  subDaily = false,
}: {
  bars: BarPoint[]
  news: News[]
  rangeDays?: number
  subDaily?: boolean
}) {
  const gradientId = React.useId().replace(/:/g, "")

  // Filter to the selected range window before building the series (mirrors the
  // price chart's visibleData), so 1Y shows ~a year of bars, not the full pull.
  const visibleBars = React.useMemo(() => {
    if (bars.length === 0 || rangeDays === Infinity) return bars
    const times = bars.map((b) =>
      typeof b.date === "number" ? b.date : Date.parse(b.date)
    )
    const latest = Math.max(...times)
    const cutoff = latest - rangeDays * DAY_MS
    const filtered = bars.filter((_, i) => times[i] >= cutoff)
    return filtered.length >= 2 ? filtered : bars
  }, [bars, rangeDays])

  const { data, markers, metric } = React.useMemo(() => {
    const series = buildActivitySeries(visibleBars, news)
    return {
      data: series.points as ActivityDatum[],
      markers: series.markers,
      metric: series.metric,
    }
  }, [visibleBars, news])

  const yMax = React.useMemo(() => {
    let max = 0
    for (const d of data) if (d.activity > max) max = d.activity
    return max > 0 ? max * 1.15 : 1
  }, [data])

  // Horizontal gradient stops that follow the prevailing sentiment along the
  // x-axis, downsampled so a 2.5k-bar (15-min) range doesn't emit thousands of
  // <stop> nodes.
  const stops = React.useMemo(() => {
    if (data.length === 0) return [] as { offset: number; color: string }[]
    const N = Math.min(data.length, 64)
    const out: { offset: number; color: string }[] = []
    for (let k = 0; k < N; k++) {
      const frac = N === 1 ? 0 : k / (N - 1)
      const idx = Math.round(frac * (data.length - 1))
      out.push({ offset: frac, color: sentimentColor(data[idx].sentiment) })
    }
    return out
  }, [data])

  if (data.length < 2) {
    return (
      <div className="px-8 pb-8">
        <p className="py-24 text-center text-sm text-muted-foreground">
          Activity data is temporarily unavailable. Retrying automatically…
        </p>
      </div>
    )
  }

  return (
    <Card className="border-0 shadow-none bg-transparent rounded-lg">
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
          <AreaChart data={data} margin={{ left: 12, right: 12 }}>
            <defs>
              <linearGradient id={`fill-${gradientId}`} x1="0" y1="0" x2="1" y2="0">
                {stops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(2)}%`}
                    stopColor={s.color}
                  />
                ))}
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
                if (subDaily) {
                  return date.toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  })
                }
                return rangeDays <= 180
                  ? date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : date.toLocaleDateString("en-US", {
                      month: "short",
                      year: "2-digit",
                    })
              }}
            />
            <YAxis hide domain={[0, yMax]} />
            <ChartTooltip
              cursor={false}
              content={<ActivityTooltip metric={metric} subDaily={subDaily} />}
            />
            <Area
              dataKey="activity"
              type="monotone"
              fill={`url(#fill-${gradientId})`}
              fillOpacity={0.2}
              stroke={`url(#fill-${gradientId})`}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            {markers.map((m, i) => (
              <ReferenceDot
                key={i}
                x={m.date}
                y={m.activity}
                r={3.5}
                fill={sentimentColor(m.sentiment)}
                stroke="var(--background)"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
              />
            ))}
          </AreaChart>
        </ChartContainer>
        {/* Legend sits outside the ChartContainer, where the injected --color-*
            vars aren't in scope, so it uses theme-aware Tailwind classes that
            mirror the chartConfig colors. The metric value and sentiment for any
            point are in the hover tooltip, so no descriptive caption is needed. */}
        <div className="flex items-center justify-center gap-4 pt-3 text-[11px]">
          <LegendDot dot="bg-green-600 dark:bg-green-500" label="Positive" />
          <LegendDot dot="bg-slate-500 dark:bg-slate-400" label="Neutral" />
          <LegendDot dot="bg-red-600 dark:bg-red-400" label="Negative" />
        </div>
      </CardContent>
    </Card>
  )
}

function LegendDot({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { innerGridLines } from "@/components/charts/grid";
import { useChart } from "@/context/ChartContext";

type ChartDataPoint = {
  date: number;
  desktop: number;
  mobile: number;
};

type IncomingPoint = { date: string | number; value: number };

const chartConfig = {
  views: {
    label: "Stock Price",
  },
  desktop: {
    label: "Price",
    theme: { light: "#0369a1", dark: "#409cff" },
  },
  mobile: {
    label: "Price",
    theme: { light: "#475569", dark: "#94a3b8" },
  },
} satisfies ChartConfig;

export default function MainChart({
  cd,
  rangeDays = 365,
  intraday = false,
}: {
  cd: IncomingPoint[];
  rangeDays?: number;
  intraday?: boolean;
}) {
  const [activeChart] = React.useState<"desktop" | "mobile">("desktop");
  const { hoveredTimestamp } = useChart();

  const chartData = React.useMemo<ChartDataPoint[]>(() => {
    if (!Array.isArray(cd)) return [];
    return cd
      .map((p) => {
        const t = typeof p.date === "number" ? p.date : new Date(p.date).getTime();
        return { date: t, desktop: p.value, mobile: p.value };
      })
      .filter((p) => !Number.isNaN(p.date))
      .sort((a, b) => a.date - b.date);
  }, [cd]);

  const visibleData = React.useMemo<ChartDataPoint[]>(() => {
    if (chartData.length === 0 || rangeDays === Infinity) return chartData;
    const latest = chartData[chartData.length - 1].date;
    const cutoff = latest - rangeDays * 24 * 60 * 60 * 1000;
    const filtered = chartData.filter((d) => d.date >= cutoff);
    return filtered.length >= 2 ? filtered : chartData;
  }, [chartData, rangeDays]);

  const yDomain = React.useMemo<[number, number]>(() => {
    if (visibleData.length === 0) return [0, 1];
    let min = Infinity;
    let max = -Infinity;
    for (const d of visibleData) {
      if (d[activeChart] < min) min = d[activeChart];
      if (d[activeChart] > max) max = d[activeChart];
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    const range = max - min;
    const pad = range > 0 ? range * 0.1 : Math.max(Math.abs(max) * 0.1, 1);
    return [min - pad, max + pad];
  }, [visibleData, activeChart]);

  const hoveredPoint = React.useMemo(() => {
    if (!hoveredTimestamp) return undefined;
    const toDayKey = (v: number | string) => {
      const d = new Date(v);
      return Number.isNaN(d.getTime())
        ? String(v)
        : d.toISOString().slice(0, 10);
    };
    const target = toDayKey(hoveredTimestamp);
    return visibleData.find((d) => toDayKey(d.date) === target);
  }, [hoveredTimestamp, visibleData]);

  if (!chartData || chartData.length === 0) {
    return (
      <Card>
        <CardContent className="px-2 sm:p-6 flex items-center justify-center min-h-[300px]">
          <p className="text-muted-foreground">No data available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 shadow-none bg-transparent">
      <CardContent className="px-2 sm:p-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] min-h-[300px] w-full"
        >
          <LineChart
            accessibilityLayer
            data={visibleData}
            margin={{
              left: 12,
              right: 12,
            }}
          >
            <CartesianGrid
              horizontalCoordinatesGenerator={({ offset }) =>
                innerGridLines(offset?.top ?? 0, offset?.height ?? 0, 4)
              }
              verticalCoordinatesGenerator={({ offset }) =>
                innerGridLines(offset?.left ?? 0, offset?.width ?? 0, 8)
              }
            />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                const date = new Date(value);
                if (intraday) {
                  return date.toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  });
                }
                return rangeDays <= 180
                  ? date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : date.toLocaleDateString("en-US", {
                      month: "short",
                      year: "2-digit",
                    });
              }}
            />
            <YAxis hide domain={yDomain} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="w-[150px]"
                  nameKey="views"
                  labelFormatter={(_value, payload) => {
                    const ts = payload?.[0]?.payload?.date ?? _value;
                    const date = new Date(ts);
                    if (Number.isNaN(date.getTime())) return "";
                    if (intraday) {
                      return date.toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      });
                    }
                    return date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    });
                  }}
                />
              }
            />
            <Line
              dataKey={activeChart}
              type="linear"
              stroke={`var(--color-${activeChart})`}
              strokeWidth={1.5}
              dot={false}
            />

            {hoveredPoint && (
              <>
                <ReferenceLine
                  x={hoveredPoint.date}
                  stroke="var(--muted-foreground)"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                />
                <ReferenceDot
                  x={hoveredPoint.date}
                  y={hoveredPoint[activeChart]}
                  r={4}
                  fill={`var(--color-${activeChart})`}
                  stroke={`var(--color-${activeChart})`}
                  strokeWidth={2}
                ></ReferenceDot>
              </>
            )}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

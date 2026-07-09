"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  Label,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useChart } from "@/context/ChartContext";
import { getStockCandles } from "@/app/alphavantage_actions";

type ChartDataPoint = {
  date: string;
  desktop: number;
  mobile: number;
};

const chartConfig = {
  views: {
    label: "Stock Price",
  },
  desktop: {
    label: "Desktop",
    color: "#0369a1",
  },
  mobile: {
    label: "Mobile",
    color: "#475569",
  },
} satisfies ChartConfig;

export default function MainChart({ cd }: { cd: any }) {
  const [activeChart, setActiveChart] = React.useState<"desktop" | "mobile">(
    "desktop"
  );
  const [chartData, setChartData] = React.useState<ChartDataPoint[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const { hoveredTimestamp } = useChart();

  React.useEffect(() => {
    getStockCandles("IBM").then((data) => {
      console.log("IBM data fetched:", data);
      setChartData(data);
      setIsLoading(false);
    });
  }, []);

  const total = React.useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return { desktop: 0, mobile: 0 };
    }
    return {
      desktop: chartData.reduce((acc, curr) => acc + (curr.desktop || 0), 0),
      mobile: chartData.reduce((acc, curr) => acc + (curr.mobile || 0), 0),
    };
  }, [chartData]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="px-2 sm:p-6 flex items-center justify-center min-h-[300px]">
          <p className="text-muted-foreground">Loading chart data...</p>
        </CardContent>
      </Card>
    );
  }

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
    <Card className="">
      <CardContent className="px-2 sm:p-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] min-h-[300px] w-full"
        >
          <LineChart
            accessibilityLayer
            data={chartData}
            margin={{
              left: 12,
              right: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                const date = new Date(value);
                
                return date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                });
              }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="w-[150px]"
                  nameKey="views"
                  labelFormatter={(value) => {
                   
                    const date = new Date(value);
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
              type="monotone"
              stroke={`var(--color-${activeChart})`}
              strokeWidth={1}
              dot={false}
            />

            {hoveredTimestamp && (
              <>
                <ReferenceLine
                  x={hoveredTimestamp}
                  stroke="rgb(205, 205, 205)"
                  strokeWidth={1}
                />
                <ReferenceDot
                  x={hoveredTimestamp}
                  y={
                    chartData.find((d) => d.date === hoveredTimestamp)?.[
                      activeChart
                    ] || 0
                  }
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

const CustomTooltip = ({ value, date }: { value: number; date: string }) => {
  return (
    <div className="bg-white p-2 rounded-lg shadow-lg border border-gray-200">
      <div className="text-sm font-medium">
        {new Date(date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })}
      </div>
      <div className="text-lg font-bold">{value} views</div>
    </div>
  );
};

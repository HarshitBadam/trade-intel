// Shared range-selector model for the chart views. The price chart (StockGraph)
// keeps its own inline copy; the popularity/activity view uses this so its 1D /
// 1W / 1M / 3M / 6M / 1Y / All buttons and lazy-range fetching behave exactly
// like the price view (same `onRequestRange` mechanism, same resolutions).

export const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGES: { label: string; days: number }[] = [
  { label: "1D", days: 1 },
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "All", days: Infinity },
];

// Which lazily-fetched series backs each range: 1D→1-min intraday, 1W→week
// slice, 1M/3M→15-min fine. Wider ranges use the daily series already loaded.
export function rangeToKind(days: number): "intraday" | "week" | "fine" | null {
  if (days === 1) return "intraday";
  if (days === 7) return "week";
  if (days === 30 || days === 90) return "fine";
  return null;
}

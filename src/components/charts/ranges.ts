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

export function rangeToKind(days: number): "intraday" | "week" | "fine" | null {
  if (days === 1) return "intraday";
  if (days === 7) return "week";
  if (days === 30 || days === 90) return "fine";
  return null;
}

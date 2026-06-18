import type { Mover } from "@/app/details/[id]/actions";

export function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** Maps a live market mover into the card shape the `TopGainer` component expects. */
export function moverToCard(m: Mover) {
  const up = m.percentChange >= 0;
  const sign = up ? "+" : "";
  return {
    ticker: m.ticker,
    name: m.name,
    currentPrice: `$${m.price.toFixed(2)}`,
    priceChange: `${sign}${m.change.toFixed(2)}`,
    percentageChange: `${sign}${m.percentChange.toFixed(2)}%`,
    volume: formatVolume(m.volume),
    sentiment: up ? "Bullish" : "Bearish",
    sentimentSource: ["Polygon"],
    reason: `Moved ${sign}${m.percentChange.toFixed(2)}% in the latest session`,
  };
}

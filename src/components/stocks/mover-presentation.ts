import { formatVolume, moveStrength } from "@/lib/market-data/transforms";
import type { Mover } from "@/lib/market-data/types";
import type { Shift } from "./Overview";

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
    sentimentSource: [moveStrength(m.percentChange)],
    reason: `Moved ${sign}${m.percentChange.toFixed(2)}% in the latest session`,
  };
}

export function moverToShift(m: Mover): Shift {
  const up = m.percentChange >= 0;
  const sign = up ? "+" : "";
  return {
    ticker: m.ticker,
    name: m.name,
    change: `${sign}${m.percentChange.toFixed(2)}%`,
    sentiment: `${up ? "Bullish" : "Bearish"} (${Math.abs(m.percentChange).toFixed(1)}%)`,
  };
}

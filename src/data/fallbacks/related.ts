import { hashTicker, seededRandom, generateMockStockData } from "./mock-generators";
import { FALLBACK_TICKERS } from "./ticker-lists";

export const CURATED_PEERS: Record<string, string[]> = {
  // IT services / consulting
  INFY: ["ACN", "CTSH", "WIT", "IBM", "EPAM", "GLOB"],
  WIT: ["INFY", "ACN", "CTSH", "IBM", "EPAM"],
  ACN: ["IBM", "CTSH", "INFY", "WIT", "EPAM"],
  CTSH: ["ACN", "INFY", "WIT", "IBM", "EPAM"],
  // Semiconductors / foundries / equipment
  TSM: ["NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "ASML"],
  ASML: ["AMAT", "LRCX", "KLAC", "TSM", "NVDA"],
  // China internet / e-commerce
  BABA: ["JD", "PDD", "AMZN", "MELI", "SE"],
  JD: ["BABA", "PDD", "AMZN", "MELI"],
  PDD: ["BABA", "JD", "AMZN", "MELI"],
  // Enterprise software
  SAP: ["ORCL", "CRM", "MSFT", "ADBE", "NOW"],
  // Pharma / healthcare ADRs
  NVO: ["LLY", "PFE", "MRK", "AMGN", "ABBV"],
  AZN: ["PFE", "MRK", "JNJ", "LLY", "BMY"],
  NVS: ["PFE", "MRK", "JNJ", "LLY", "ABBV"],
  GSK: ["PFE", "MRK", "JNJ", "AZN", "BMY"],
  // Autos
  TM: ["GM", "F", "HMC", "STLA", "TSLA"],
  HMC: ["TM", "GM", "F", "STLA"],
  // Consumer / staples
  UL: ["PG", "KO", "CL", "KMB", "PEP"],
  // Banks
  HSBC: ["JPM", "BAC", "C", "WFC"],
  // Energy majors
  BP: ["XOM", "CVX", "SHEL", "COP"],
  SHEL: ["XOM", "CVX", "BP", "COP"],
  // Consumer electronics / gaming
  SONY: ["MSFT", "AAPL", "EA", "TTWO"],
};

export function getCuratedPeers(symbol: string): string[] {
  return CURATED_PEERS[symbol.toUpperCase()] ?? [];
}

export type RelatedStock = {
  ticker: string;
  name: string;
  currentPrice: string;
  priceChange: string;
  percentageChange: string;
  volume: string;
  sentiment: string;
  sentimentSource: string[];
  reason: string;
};

const RELATED_REASONS = [
  "Momentum building on strong sector demand",
  "Analysts revising estimates ahead of earnings",
  "Cooling off after a recent rally",
  "Mixed signals as the market weighs guidance",
  "Riding broader tech-sector optimism",
];

export function getRelatedStocks(
  currentTicker: string,
  count = 3
): RelatedStock[] {
  const symbol = currentTicker.toUpperCase();
  const peers = FALLBACK_TICKERS.filter((t) => t.ticker !== symbol);
  const start = hashTicker(symbol) % peers.length;

  return Array.from({ length: Math.min(count, peers.length) }, (_, i) => {
    const peer = peers[(start + i) % peers.length];
    const data = generateMockStockData(peer.ticker);
    const rand = seededRandom(hashTicker(peer.ticker) ^ 0xa17e);
    const up = data.price_change >= 0;
    const sentimentPct = 50 + Math.floor(rand() * 35);
    const volume = (10 + rand() * 90).toFixed(1);
    return {
      ticker: peer.ticker,
      name: peer.name,
      currentPrice: `$${data.stock_price.toFixed(2)}`,
      priceChange: `${up ? "+" : ""}${data.price_change.toFixed(2)}`,
      percentageChange: `${up ? "+" : ""}${data.percent_change.toFixed(2)}%`,
      volume: `${volume}M`,
      sentiment: `${sentimentPct}% ${up ? "Bullish" : "Bearish"}`,
      sentimentSource: ["News", "Analyst Ratings"],
      reason: RELATED_REASONS[Math.floor(rand() * RELATED_REASONS.length)],
    };
  });
}

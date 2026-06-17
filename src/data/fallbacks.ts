import { News } from "@/components/RecentInfluential";

/**
 * Demo-mode fallbacks.
 *
 * Used whenever external services (Polygon.io, Astra DB, Langflow) are not
 * configured or unreachable, so the whole UI stays functional out of the box.
 * Data is deterministic per ticker so charts look stable between renders.
 */

function hashTicker(ticker: string): number {
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) {
    hash = (hash * 31 + ticker.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Mulberry32 PRNG - cheap, deterministic
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMockCandles(ticker: string, days = 250) {
  const rand = seededRandom(hashTicker(ticker));
  const basePrice = 40 + rand() * 460; // somewhere between $40 and $500
  const drift = (rand() - 0.45) * 0.002; // slight bias up or down

  const candles: { date: string; value: number }[] = [];
  let price = basePrice;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = days; i >= 0; i--) {
    const change = price * (drift + (rand() - 0.5) * 0.03);
    price = Math.max(1, price + change);
    candles.push({
      date: new Date(now - i * dayMs).toISOString(),
      value: Number(price.toFixed(2)),
    });
  }
  return candles;
}

export function generateMockStockData(ticker: string) {
  const chartData = generateMockCandles(ticker);
  const last = chartData[chartData.length - 1].value;
  const prev = chartData[chartData.length - 2].value;
  return {
    chart_data: chartData,
    stock_price: last,
    price_change: Number((last - prev).toFixed(2)),
    percent_change: Number((((last - prev) / prev) * 100).toFixed(2)),
  };
}

const MOCK_HEADLINES: Array<{
  event: string;
  sentiment: "Positive" | "Negative" | "Neutral";
  importance: string;
  observation: string;
  source: string;
}> = [
  {
    event: "Quarterly earnings beat expectations",
    sentiment: "Positive",
    importance: "high",
    observation:
      "Revenue and EPS came in above analyst consensus, driven by stronger than expected demand.",
    source: "Demo Newswire",
  },
  {
    event: "Analyst upgrades price target",
    sentiment: "Positive",
    importance: "medium",
    observation:
      "A major bank raised its price target citing improving margins and product momentum.",
    source: "Demo Research",
  },
  {
    event: "Supply chain pressure flagged",
    sentiment: "Negative",
    importance: "medium",
    observation:
      "Management flagged near-term component shortages that may affect next quarter shipments.",
    source: "Demo Business Daily",
  },
  {
    event: "New product line announced",
    sentiment: "Positive",
    importance: "high",
    observation:
      "The company unveiled a new product line expected to open an additional revenue stream.",
    source: "Demo Tech Desk",
  },
  {
    event: "Regulatory inquiry reported",
    sentiment: "Negative",
    importance: "low",
    observation:
      "Reports suggest a preliminary regulatory inquiry; impact considered limited at this stage.",
    source: "Demo Wire",
  },
];

export function generateMockNews(ticker: string): News[] {
  const rand = seededRandom(hashTicker(ticker) ^ 0xbeef);
  const count = 3 + Math.floor(rand() * 3);
  const dayMs = 24 * 60 * 60 * 1000;

  return Array.from({ length: count }, (_, i) => {
    const headline = MOCK_HEADLINES[Math.floor(rand() * MOCK_HEADLINES.length)];
    const date = new Date(Date.now() - Math.floor(rand() * 14) * dayMs);
    return {
      _id: `${ticker}-mock-${i}`,
      page_content: headline.observation,
      metadata: {
        title: `${ticker}: ${headline.event}`,
        source: headline.source,
        publication_date: date.toISOString().slice(0, 10),
        importance: headline.importance,
        sentiment: headline.sentiment,
        key_observations: headline.observation,
        url: "#",
        ticker: ticker,
        description: headline.observation,
        event: headline.event,
      },
    };
  });
}

export const FALLBACK_TICKERS = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "NFLX", name: "Netflix Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices Inc." },
  { ticker: "IBM", name: "International Business Machines" },
];

export function searchFallbackTickers(query: string) {
  const q = query.trim().toLowerCase();
  return FALLBACK_TICKERS.filter(
    (t) =>
      t.ticker.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
  ).slice(0, 5);
}

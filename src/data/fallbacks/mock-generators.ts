import { News } from "@/components/news/RecentInfluential";

export function hashTicker(ticker: string): number {
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) {
    hash = (hash * 31 + ticker.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Mulberry32 PRNG
export function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bar type carried by every mock series: `value` is the close, `volume`/`trades`
// feed the popularity activity chart (kept on a SEPARATE PRNG stream so the
// existing mock price series is unchanged). See `BarPoint` in market-data/types.
type MockBar = { date: string; value: number; volume: number; trades: number };

// Plausible trade count from a share volume (avg trade size varies a bit).
function tradesFrom(volume: number, rand: () => number): number {
  return Math.max(1, Math.round(volume / (150 + rand() * 350)));
}

export function generateMockCandles(ticker: string, days = 5 * 365) {
  const rand = seededRandom(hashTicker(ticker));
  const volRand = seededRandom(hashTicker(ticker) ^ 0x0107ff);
  const basePrice = 40 + rand() * 460;
  const drift = (rand() - 0.45) * 0.002;
  const baseVol = 500_000 + Math.floor(volRand() * 25_000_000);

  const candles: MockBar[] = [];
  let price = basePrice;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = days; i >= 0; i--) {
    const change = price * (drift + (rand() - 0.5) * 0.03);
    price = Math.max(1, price + change);
    const volume = Math.round(baseVol * (0.5 + volRand()));
    candles.push({
      date: new Date(now - i * dayMs).toISOString(),
      value: Number(price.toFixed(2)),
      volume,
      trades: tradesFrom(volume, volRand),
    });
  }
  return candles;
}

export function generateMockWeek(ticker: string, days = 7) {
  const daily = generateMockCandles(ticker);
  const anchor = daily[daily.length - 1].value;
  const rand = seededRandom(hashTicker(ticker) ^ 0x55aa);
  const volRand = seededRandom(hashTicker(ticker) ^ 0x55aa ^ 0x0107ff);

  const points: MockBar[] = [];
  const stepMs = 15 * 60 * 1000;
  const steps = Math.round((days * 24 * 60) / 15);
  const now = Date.now();
  let price = anchor * (0.97 + rand() * 0.02);
  // ~26 fifteen-minute bars per trading day.
  const perBar = (daily[daily.length - 1].volume ?? 1_000_000) / 26;

  for (let i = steps; i >= 0; i--) {
    price = Math.max(1, price + price * (rand() - 0.49) * 0.004);
    const volume = Math.max(1, Math.round(perBar * (0.4 + volRand() * 1.2)));
    points.push({
      date: new Date(now - i * stepMs).toISOString(),
      value: Number(price.toFixed(2)),
      volume,
      trades: tradesFrom(volume, volRand),
    });
  }
  return points;
}

export function generateMockFine(ticker: string, days = 95) {
  const daily = generateMockCandles(ticker);
  const anchor = daily[daily.length - 1].value;
  const rand = seededRandom(hashTicker(ticker) ^ 0x77ee);
  const volRand = seededRandom(hashTicker(ticker) ^ 0x77ee ^ 0x0107ff);

  const points: MockBar[] = [];
  const stepMs = 15 * 60 * 1000;
  const steps = Math.round((days * 24 * 60) / 15);
  const now = Date.now();
  // Start below the anchor so the series ends near the current price
  let price = anchor * (0.9 + rand() * 0.06);
  const perBar = (daily[daily.length - 1].volume ?? 1_000_000) / 26;

  for (let i = steps; i >= 0; i--) {
    // Smaller per-step move than the old hourly mock so 4x the points keep a
    // comparable overall drift instead of swinging wildly.
    price = Math.max(1, price + price * (rand() - 0.49) * 0.0035);
    const volume = Math.max(1, Math.round(perBar * (0.4 + volRand() * 1.2)));
    points.push({
      date: new Date(now - i * stepMs).toISOString(),
      value: Number(price.toFixed(2)),
      volume,
      trades: tradesFrom(volume, volRand),
    });
  }
  return points;
}

export function generateMockIntraday(ticker: string) {
  const daily = generateMockCandles(ticker);
  const anchor = daily[daily.length - 1].value;
  const rand = seededRandom(hashTicker(ticker) ^ 0x1d1d);
  const volRand = seededRandom(hashTicker(ticker) ^ 0x1d1d ^ 0x0107ff);

  const points: MockBar[] = [];
  const steps = 390;
  const stepMs = 60 * 1000;
  const now = Date.now();
  let price = anchor * (0.99 + rand() * 0.02);
  // 390 one-minute bars per regular trading session.
  const perBar = (daily[daily.length - 1].volume ?? 1_000_000) / 390;

  for (let i = steps; i >= 0; i--) {
    price = Math.max(1, price + price * (rand() - 0.5) * 0.0018);
    const volume = Math.max(1, Math.round(perBar * (0.3 + volRand() * 1.4)));
    points.push({
      date: new Date(now - i * stepMs).toISOString(),
      value: Number(price.toFixed(2)),
      volume,
      trades: tradesFrom(volume, volRand),
    });
  }
  return points;
}

export function generateMockStockData(ticker: string) {
  const chartData = generateMockCandles(ticker);
  const last = chartData[chartData.length - 1];
  const prev = chartData[chartData.length - 2].value;
  return {
    chart_data: chartData,
    stock_price: last.value,
    price_change: Number((last.value - prev).toFixed(2)),
    percent_change: Number((((last.value - prev) / prev) * 100).toFixed(2)),
    latest_volume: last.volume,
  };
}

export function generateMockPopularity(ticker: string, days = 90) {
  const rand = seededRandom(hashTicker(ticker) ^ 0x50c1a1);
  const popularityRate = 55 + Math.floor(rand() * 44);
  const searchVolume = Math.floor((250 + rand() * 950) * 1000);
  const series: { date: string; positive: number; negative: number }[] = [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let pos = 200 + rand() * 200;
  let neg = 200 + rand() * 200;
  for (let i = days; i >= 0; i--) {
    pos = Math.max(40, pos + (rand() - 0.5) * 120);
    neg = Math.max(40, neg + (rand() - 0.5) * 120);
    series.push({
      date: new Date(now - i * dayMs).toISOString().slice(0, 10),
      positive: Math.round(pos),
      negative: Math.round(neg),
    });
  }
  return { popularityRate, searchVolume, series };
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

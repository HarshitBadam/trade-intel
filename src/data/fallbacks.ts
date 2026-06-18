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

// ~5 years of daily candles so every range (1W → All) is fully populated and
// matches the live Polygon window.
export function generateMockCandles(ticker: string, days = 5 * 365) {
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

// Deterministic 15-minute candles for the last ~7 days, anchored to the last
// daily close. Powers the 1W view at a much finer resolution than the shared
// hourly tier (~130 trading-hour points for a real ticker).
export function generateMockWeek(ticker: string, days = 7) {
  const daily = generateMockCandles(ticker);
  const anchor = daily[daily.length - 1].value;
  const rand = seededRandom(hashTicker(ticker) ^ 0x55aa);

  const points: { date: string; value: number }[] = [];
  const stepMs = 15 * 60 * 1000;
  const steps = Math.round((days * 24 * 60) / 15);
  const now = Date.now();
  let price = anchor * (0.97 + rand() * 0.02);

  for (let i = steps; i >= 0; i--) {
    price = Math.max(1, price + price * (rand() - 0.49) * 0.004);
    points.push({
      date: new Date(now - i * stepMs).toISOString(),
      value: Number(price.toFixed(2)),
    });
  }
  return points;
}

// Deterministic 1-hour candles for the last ~95 days, anchored to the last
// daily close. Powers the 1W / 1M / 3M views with a genuinely dense series
// (hundreds of points) instead of the coarse daily zigzag. 6M+ stays on daily
// candles. Real tickers only have trading-hour bars, so live data is sparser
// than this 24/7 mock — both still read as a smooth line.
export function generateMockFine(ticker: string, days = 95) {
  const daily = generateMockCandles(ticker);
  const anchor = daily[daily.length - 1].value;
  const rand = seededRandom(hashTicker(ticker) ^ 0x77ee);

  const points: { date: string; value: number }[] = [];
  const stepHours = 1;
  const steps = Math.round((days * 24) / stepHours);
  const stepMs = stepHours * 60 * 60 * 1000;
  const now = Date.now();
  // Start below the anchor and drift up to it so the series ends near the
  // current price.
  let price = anchor * (0.9 + rand() * 0.06);

  for (let i = steps; i >= 0; i--) {
    price = Math.max(1, price + price * (rand() - 0.49) * 0.006);
    points.push({
      date: new Date(now - i * stepMs).toISOString(),
      value: Number(price.toFixed(2)),
    });
  }
  return points;
}

// Deterministic intraday (5-minute) candles for the most recent ~6.5h session,
// anchored to the last daily close so the 1D view is continuous with the rest.
export function generateMockIntraday(ticker: string) {
  const daily = generateMockCandles(ticker);
  const anchor = daily[daily.length - 1].value;
  const rand = seededRandom(hashTicker(ticker) ^ 0x1d1d);

  const points: { date: string; value: number }[] = [];
  const steps = 78; // 6.5 trading hours @ 5-min bars
  const stepMs = 5 * 60 * 1000;
  const now = Date.now();
  let price = anchor * (0.99 + rand() * 0.02);

  for (let i = steps; i >= 0; i--) {
    price = Math.max(1, price + price * (rand() - 0.5) * 0.004);
    points.push({
      date: new Date(now - i * stepMs).toISOString(),
      value: Number(price.toFixed(2)),
    });
  }
  return points;
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

// Deterministic, per-ticker "social popularity" data for the flip-card back.
// There's no real social-data source wired up, so this is clearly illustrative
// (the UI labels it as such) — but at least it's distinct per ticker and stable
// between renders instead of one shared hardcoded series for every stock.
export function generateMockPopularity(ticker: string, days = 90) {
  const rand = seededRandom(hashTicker(ticker) ^ 0x50c1a1);
  const popularityRate = 55 + Math.floor(rand() * 44); // 55–98
  const searchVolume = Math.floor((250 + rand() * 950) * 1000); // 250k–1.2M
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

/**
 * Curated, sector-diverse universe the daily cron rotates through to pre-warm
 * Astra news. It's intentionally larger than a single run's budget: the cron
 * ingests a rotating slice of `MAX_INGESTS_PER_RUN` each day (round-robin keyed
 * by the date), so coverage spreads across the whole list over ~a week instead
 * of hammering the same handful. Long-tail tickers are still covered on-demand
 * the moment a user visits them.
 */
export const CRON_WARMUP_TICKERS = [
  // Mega-cap tech
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices Inc." },
  { ticker: "ORCL", name: "Oracle Corporation" },
  { ticker: "CRM", name: "Salesforce Inc." },
  { ticker: "ADBE", name: "Adobe Inc." },
  // Consumer / discretionary
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "NFLX", name: "Netflix Inc." },
  { ticker: "DIS", name: "The Walt Disney Company" },
  { ticker: "NKE", name: "Nike Inc." },
  { ticker: "SBUX", name: "Starbucks Corporation" },
  { ticker: "MCD", name: "McDonald's Corporation" },
  // Consumer staples / retail
  { ticker: "WMT", name: "Walmart Inc." },
  { ticker: "COST", name: "Costco Wholesale Corporation" },
  { ticker: "KO", name: "The Coca-Cola Company" },
  // Financials
  { ticker: "JPM", name: "JPMorgan Chase & Co." },
  { ticker: "BAC", name: "Bank of America Corporation" },
  { ticker: "V", name: "Visa Inc." },
  { ticker: "MA", name: "Mastercard Incorporated" },
  // Healthcare
  { ticker: "JNJ", name: "Johnson & Johnson" },
  { ticker: "LLY", name: "Eli Lilly and Company" },
  { ticker: "UNH", name: "UnitedHealth Group Incorporated" },
  // Energy / industrial / comms
  { ticker: "XOM", name: "Exxon Mobil Corporation" },
  { ticker: "CVX", name: "Chevron Corporation" },
  { ticker: "BA", name: "The Boeing Company" },
  { ticker: "CAT", name: "Caterpillar Inc." },
];

/**
 * Broad, curated index of well-known US-listed stocks, popular ADRs and major
 * ETFs. This is the type-ahead SAFETY NET: Polygon's live ticker search is the
 * primary source, but its free tier is ~5 req/min, so the moment it rate-limits
 * (429) we still want common names (TEAM, INFY, …) to resolve instead of
 * "No stocks found". Ordered roughly by familiarity so short prefixes surface
 * the most recognizable matches first.
 */
export const SEARCH_TICKERS: { ticker: string; name: string }[] = [
  // Mega-cap tech
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "GOOGL", name: "Alphabet Inc. (Class A)" },
  { ticker: "GOOG", name: "Alphabet Inc. (Class C)" },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "AVGO", name: "Broadcom Inc." },
  { ticker: "ORCL", name: "Oracle Corporation" },
  { ticker: "CRM", name: "Salesforce Inc." },
  { ticker: "ADBE", name: "Adobe Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices Inc." },
  { ticker: "INTC", name: "Intel Corporation" },
  { ticker: "CSCO", name: "Cisco Systems Inc." },
  { ticker: "QCOM", name: "QUALCOMM Incorporated" },
  { ticker: "TXN", name: "Texas Instruments Incorporated" },
  { ticker: "IBM", name: "International Business Machines" },
  { ticker: "NOW", name: "ServiceNow Inc." },
  { ticker: "INTU", name: "Intuit Inc." },
  { ticker: "AMAT", name: "Applied Materials Inc." },
  { ticker: "MU", name: "Micron Technology Inc." },
  { ticker: "ADI", name: "Analog Devices Inc." },
  { ticker: "PANW", name: "Palo Alto Networks Inc." },
  { ticker: "SNPS", name: "Synopsys Inc." },
  { ticker: "CDNS", name: "Cadence Design Systems Inc." },
  { ticker: "KLAC", name: "KLA Corporation" },
  { ticker: "MRVL", name: "Marvell Technology Inc." },
  { ticker: "FTNT", name: "Fortinet Inc." },
  // Software / internet / fintech
  { ticker: "NFLX", name: "Netflix Inc." },
  { ticker: "UBER", name: "Uber Technologies Inc." },
  { ticker: "ABNB", name: "Airbnb Inc." },
  { ticker: "SHOP", name: "Shopify Inc." },
  { ticker: "PYPL", name: "PayPal Holdings Inc." },
  { ticker: "SNOW", name: "Snowflake Inc." },
  { ticker: "PLTR", name: "Palantir Technologies Inc." },
  { ticker: "CRWD", name: "CrowdStrike Holdings Inc." },
  { ticker: "DDOG", name: "Datadog Inc." },
  { ticker: "NET", name: "Cloudflare Inc." },
  { ticker: "ZS", name: "Zscaler Inc." },
  { ticker: "MDB", name: "MongoDB Inc." },
  { ticker: "TEAM", name: "Atlassian Corporation" },
  { ticker: "WDAY", name: "Workday Inc." },
  { ticker: "DOCU", name: "Docusign Inc." },
  { ticker: "ZM", name: "Zoom Communications Inc." },
  { ticker: "OKTA", name: "Okta Inc." },
  { ticker: "TWLO", name: "Twilio Inc." },
  { ticker: "HUBS", name: "HubSpot Inc." },
  { ticker: "DASH", name: "DoorDash Inc." },
  { ticker: "COIN", name: "Coinbase Global Inc." },
  { ticker: "RBLX", name: "Roblox Corporation" },
  { ticker: "SPOT", name: "Spotify Technology S.A." },
  { ticker: "PINS", name: "Pinterest Inc." },
  { ticker: "SNAP", name: "Snap Inc." },
  { ticker: "RDDT", name: "Reddit Inc." },
  { ticker: "HOOD", name: "Robinhood Markets Inc." },
  { ticker: "SOFI", name: "SoFi Technologies Inc." },
  // ADRs / international
  { ticker: "TSM", name: "Taiwan Semiconductor Manufacturing" },
  { ticker: "BABA", name: "Alibaba Group Holding Limited" },
  { ticker: "INFY", name: "Infosys Limited" },
  { ticker: "WIT", name: "Wipro Limited" },
  { ticker: "SAP", name: "SAP SE" },
  { ticker: "SE", name: "Sea Limited" },
  { ticker: "NVO", name: "Novo Nordisk A/S" },
  { ticker: "AZN", name: "AstraZeneca PLC" },
  { ticker: "NVS", name: "Novartis AG" },
  { ticker: "TM", name: "Toyota Motor Corporation" },
  { ticker: "SONY", name: "Sony Group Corporation" },
  { ticker: "BP", name: "BP p.l.c." },
  { ticker: "SHEL", name: "Shell plc" },
  { ticker: "HSBC", name: "HSBC Holdings plc" },
  { ticker: "UL", name: "Unilever PLC" },
  { ticker: "JD", name: "JD.com Inc." },
  { ticker: "PDD", name: "PDD Holdings Inc." },
  { ticker: "NIO", name: "NIO Inc." },
  { ticker: "ASML", name: "ASML Holding N.V." },
  // Financials
  { ticker: "JPM", name: "JPMorgan Chase & Co." },
  { ticker: "BAC", name: "Bank of America Corporation" },
  { ticker: "WFC", name: "Wells Fargo & Company" },
  { ticker: "C", name: "Citigroup Inc." },
  { ticker: "GS", name: "The Goldman Sachs Group Inc." },
  { ticker: "MS", name: "Morgan Stanley" },
  { ticker: "V", name: "Visa Inc." },
  { ticker: "MA", name: "Mastercard Incorporated" },
  { ticker: "AXP", name: "American Express Company" },
  { ticker: "BLK", name: "BlackRock Inc." },
  { ticker: "SCHW", name: "The Charles Schwab Corporation" },
  { ticker: "COF", name: "Capital One Financial Corporation" },
  // Healthcare
  { ticker: "JNJ", name: "Johnson & Johnson" },
  { ticker: "LLY", name: "Eli Lilly and Company" },
  { ticker: "PFE", name: "Pfizer Inc." },
  { ticker: "MRK", name: "Merck & Co. Inc." },
  { ticker: "ABBV", name: "AbbVie Inc." },
  { ticker: "UNH", name: "UnitedHealth Group Incorporated" },
  { ticker: "TMO", name: "Thermo Fisher Scientific Inc." },
  { ticker: "ABT", name: "Abbott Laboratories" },
  { ticker: "DHR", name: "Danaher Corporation" },
  { ticker: "BMY", name: "Bristol-Myers Squibb Company" },
  { ticker: "AMGN", name: "Amgen Inc." },
  { ticker: "GILD", name: "Gilead Sciences Inc." },
  { ticker: "CVS", name: "CVS Health Corporation" },
  { ticker: "MRNA", name: "Moderna Inc." },
  // Consumer
  { ticker: "WMT", name: "Walmart Inc." },
  { ticker: "COST", name: "Costco Wholesale Corporation" },
  { ticker: "KO", name: "The Coca-Cola Company" },
  { ticker: "PEP", name: "PepsiCo Inc." },
  { ticker: "MCD", name: "McDonald's Corporation" },
  { ticker: "SBUX", name: "Starbucks Corporation" },
  { ticker: "NKE", name: "Nike Inc." },
  { ticker: "DIS", name: "The Walt Disney Company" },
  { ticker: "HD", name: "The Home Depot Inc." },
  { ticker: "LOW", name: "Lowe's Companies Inc." },
  { ticker: "TGT", name: "Target Corporation" },
  { ticker: "PG", name: "The Procter & Gamble Company" },
  { ticker: "PM", name: "Philip Morris International Inc." },
  { ticker: "CL", name: "Colgate-Palmolive Company" },
  // Autos / EV
  { ticker: "F", name: "Ford Motor Company" },
  { ticker: "GM", name: "General Motors Company" },
  { ticker: "RIVN", name: "Rivian Automotive Inc." },
  { ticker: "LCID", name: "Lucid Group Inc." },
  // Energy / industrial
  { ticker: "XOM", name: "Exxon Mobil Corporation" },
  { ticker: "CVX", name: "Chevron Corporation" },
  { ticker: "COP", name: "ConocoPhillips" },
  { ticker: "BA", name: "The Boeing Company" },
  { ticker: "CAT", name: "Caterpillar Inc." },
  { ticker: "GE", name: "GE Aerospace" },
  { ticker: "HON", name: "Honeywell International Inc." },
  { ticker: "UPS", name: "United Parcel Service Inc." },
  { ticker: "LMT", name: "Lockheed Martin Corporation" },
  { ticker: "DE", name: "Deere & Company" },
  // Communications
  { ticker: "T", name: "AT&T Inc." },
  { ticker: "VZ", name: "Verizon Communications Inc." },
  { ticker: "TMUS", name: "T-Mobile US Inc." },
  // Popular retail names
  { ticker: "GME", name: "GameStop Corp." },
  { ticker: "AMC", name: "AMC Entertainment Holdings Inc." },
  // Major ETFs
  { ticker: "SPY", name: "SPDR S&P 500 ETF Trust" },
  { ticker: "QQQ", name: "Invesco QQQ Trust" },
  { ticker: "VOO", name: "Vanguard S&P 500 ETF" },
  { ticker: "VTI", name: "Vanguard Total Stock Market ETF" },
  { ticker: "IWM", name: "iShares Russell 2000 ETF" },
  { ticker: "DIA", name: "SPDR Dow Jones Industrial Average ETF" },
  { ticker: "ARKK", name: "ARK Innovation ETF" },
];

/**
 * Rank local matches so the dropdown still feels sane when Polygon is
 * unavailable / rate-limited: exact ticker → ticker prefix → ticker substring →
 * name prefix → name substring. Mirrors how a user expects a symbol search to
 * behave (typing "TEAM" surfaces the TEAM ticker first, not a name match).
 */
export function searchFallbackTickers(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked = SEARCH_TICKERS.map((t) => {
    const tk = t.ticker.toLowerCase();
    const nm = t.name.toLowerCase();
    let score = -1;
    if (tk === q) score = 0;
    else if (tk.startsWith(q)) score = 1;
    else if (tk.includes(q)) score = 2;
    else if (nm.startsWith(q)) score = 3;
    else if (nm.includes(q)) score = 4;
    return { t, score };
  })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score);
  return ranked.slice(0, 6).map((x) => x.t);
}

/**
 * Editorial peer map for the "Related Stocks" rail.
 *
 * Polygon's related-companies graph is excellent for US large/mid-caps but is
 * EMPTY for many foreign ADRs (INFY, TSM, BABA, SAP, …) and thinly-covered
 * names — those records often don't even carry a SIC industry code. Rather than
 * let the rail silently vanish (or pad it with irrelevant mega-caps), we fall
 * back to this hand-curated list of GENUINE industry competitors.
 *
 * Every peer is US-listed so it resolves to a real live quote from the market
 * snapshot. Keys and values are upper-case tickers. Only consulted when
 * Polygon's own peer graph returns nothing for the symbol.
 */
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

/** Genuine industry peers for `symbol`, used only when Polygon has no graph. */
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

/**
 * Deterministic peer stocks for the "related" rails on a details page. Picks
 * real tickers (never the one being viewed) and derives stable price/sentiment
 * numbers from the same seeded generator the charts use, so the cards are
 * distinct and consistent between renders instead of three identical AAPL cards.
 */
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

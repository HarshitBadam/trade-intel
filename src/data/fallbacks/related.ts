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

// Sector cohorts for names where Finnhub's live peer feed is noisy (e.g.
// foreign ADRs return ASX-listed tickers our US price provider can't chart).
// These seed the peer pool first; the live feed supplements. Ordered to span
// market caps so "Similar Market Cap" has a close match. Any ticker not listed
// here still uses only the live feed.
const PEER_GROUPS: string[][] = [
  ["MSFT", "AAPL", "GOOGL", "AMZN", "META", "ORCL"],
  // SaaS / enterprise software
  ["CRM", "NOW", "SNOW", "DDOG", "MDB", "WDAY", "HUBS", "TEAM", "ADBE", "INTU", "SAP"],
  // Cybersecurity
  ["CRWD", "PANW", "ZS", "FTNT", "NET", "OKTA", "S"],
  // Semiconductors / equipment / EDA
  ["NVDA", "AMD", "AVGO", "TSM", "QCOM", "MU", "TXN", "INTC", "AMAT", "ADI", "KLAC", "MRVL", "ASML", "SNPS", "CDNS"],
  // Streaming / media
  ["NFLX", "DIS", "SPOT", "WBD", "RBLX"],
  // Gig / travel platforms
  ["UBER", "ABNB", "DASH", "LYFT"],
  // Social platforms
  ["PINS", "SNAP", "RDDT", "META"],
  // Consumer fintech
  ["PYPL", "COIN", "HOOD", "SOFI", "AFRM", "SQ"],
  // Banks
  ["JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "COF", "USB"],
  // Payment networks
  ["V", "MA", "AXP"],
  // Pharma / biotech (US-listed; ADRs like NVO omitted, Finnhub reports their
  // cap in local currency and inflates it relative to USD-listed peers)
  ["LLY", "PFE", "MRK", "ABBV", "BMY", "AMGN", "GILD", "MRNA"],
  // Healthcare services / devices
  ["UNH", "JNJ", "TMO", "ABT", "DHR", "CVS"],
  // Retail
  ["WMT", "COST", "TGT", "HD", "LOW", "DG"],
  // Consumer staples
  ["KO", "PEP", "PG", "CL", "PM", "MDLZ"],
  // Restaurants
  ["MCD", "SBUX", "CMG"],
  // Autos / EV
  ["TSLA", "F", "GM", "RIVN", "LCID", "TM"],
  // Energy majors
  ["XOM", "CVX", "COP", "BP", "SHEL"],
  // Industrials
  ["BA", "CAT", "GE", "HON", "UPS", "LMT", "DE"],
  // Telecom
  ["T", "VZ", "TMUS"],
  // IT services / consulting (INR-listed INFY/WIT excluded; see ADR note above)
  ["ACN", "CTSH", "IBM", "EPAM"],
];

const GROUP_INDEX: Record<string, string[]> = (() => {
  const idx: Record<string, string[]> = {};
  for (const group of PEER_GROUPS) {
    for (const t of group) {
      if (!idx[t]) idx[t] = group.filter((x) => x !== t);
    }
  }
  return idx;
})();

export function getGroupPeers(symbol: string): string[] {
  return GROUP_INDEX[symbol.toUpperCase()] ?? [];
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

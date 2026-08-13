export const CURATED_PEERS: Record<string, string[]> = {
  INFY: ["ACN", "CTSH", "WIT", "IBM", "EPAM", "GLOB"],
  WIT: ["INFY", "ACN", "CTSH", "IBM", "EPAM"],
  ACN: ["IBM", "CTSH", "INFY", "WIT", "EPAM"],
  CTSH: ["ACN", "INFY", "WIT", "IBM", "EPAM"],
  TSM: ["NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "ASML"],
  ASML: ["AMAT", "LRCX", "KLAC", "TSM", "NVDA"],
  BABA: ["JD", "PDD", "AMZN", "MELI", "SE"],
  JD: ["BABA", "PDD", "AMZN", "MELI"],
  PDD: ["BABA", "JD", "AMZN", "MELI"],
  SAP: ["ORCL", "CRM", "MSFT", "ADBE", "NOW"],
  NVO: ["LLY", "PFE", "MRK", "AMGN", "ABBV"],
  AZN: ["PFE", "MRK", "JNJ", "LLY", "BMY"],
  NVS: ["PFE", "MRK", "JNJ", "LLY", "ABBV"],
  GSK: ["PFE", "MRK", "JNJ", "AZN", "BMY"],
  TM: ["GM", "F", "HMC", "STLA", "TSLA"],
  HMC: ["TM", "GM", "F", "STLA"],
  UL: ["PG", "KO", "CL", "KMB", "PEP"],
  HSBC: ["JPM", "BAC", "C", "WFC"],
  BP: ["XOM", "CVX", "SHEL", "COP"],
  SHEL: ["XOM", "CVX", "BP", "COP"],
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
  ["CRM", "NOW", "SNOW", "DDOG", "MDB", "WDAY", "HUBS", "TEAM", "ADBE", "INTU", "SAP"],
  ["CRWD", "PANW", "ZS", "FTNT", "NET", "OKTA", "S"],
  ["NVDA", "AMD", "AVGO", "TSM", "QCOM", "MU", "TXN", "INTC", "AMAT", "ADI", "KLAC", "MRVL", "ASML", "SNPS", "CDNS"],
  ["NFLX", "DIS", "SPOT", "WBD", "RBLX"],
  ["UBER", "ABNB", "DASH", "LYFT"],
  ["PINS", "SNAP", "RDDT", "META"],
  ["PYPL", "COIN", "HOOD", "SOFI", "AFRM", "SQ"],
  ["JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "COF", "USB"],
  ["V", "MA", "AXP"],
  // Pharma / biotech (US-listed; ADRs like NVO omitted, Finnhub reports their
  // cap in local currency and inflates it relative to USD-listed peers)
  ["LLY", "PFE", "MRK", "ABBV", "BMY", "AMGN", "GILD", "MRNA"],
  ["UNH", "JNJ", "TMO", "ABT", "DHR", "CVS"],
  ["WMT", "COST", "TGT", "HD", "LOW", "DG"],
  ["KO", "PEP", "PG", "CL", "PM", "MDLZ"],
  ["MCD", "SBUX", "CMG"],
  ["TSLA", "F", "GM", "RIVN", "LCID", "TM"],
  ["XOM", "CVX", "COP", "BP", "SHEL"],
  ["BA", "CAT", "GE", "HON", "UPS", "LMT", "DE"],
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

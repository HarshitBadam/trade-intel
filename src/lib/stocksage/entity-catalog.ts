export type WebAlias = {
  name: string;
  query: string;
  ticker?: string;
  aliases: string[];
  jurisdiction?: string;
  market?: "us" | "web" | "index" | "au";
  // Privately held: flows through the same news pipeline, skips market data.
  private?: true;
};

// Stooq is keyless, so index and AU coverage costs nothing. Symbols verified
// against stooq.com's symbol lookup (2026-07-16): ^SPX (S&P 500 series),
// ^NDQ (Nasdaq Composite), ^DJI (Dow series), ^AOR (All Ordinaries — Stooq
// carries no S&P/ASX 200 series, so the All Ords is the closest broad
// Australian index it offers). Australian banks trade on Stooq via their
// US-listed ADRs (CMWAY etc.), the only keyless AU-equity series it has;
// the note keeps that honest in every rendered quote.
export type StooqListing = { symbol: string; note?: string; index?: true };

export const STOOQ_SYMBOLS: Record<string, StooqListing> = {
  GSPC: { symbol: "^spx", index: true },
  IXIC: { symbol: "^ndq", index: true },
  DJI: { symbol: "^dji", index: true },
  AXJO: {
    symbol: "^aor",
    index: true,
    note: "All Ordinaries index — the broad Australian market benchmark",
  },
  CBA: { symbol: "cmway.us", note: "US-listed ADR, USD" },
  NAB: { symbol: "nabzy.us", note: "US-listed ADR, USD" },
  ANZ: { symbol: "anzgy.us", note: "US-listed ADR, USD" },
  WBC: { symbol: "wbkcy.us", note: "US-listed ADR, USD" },
  MQG: { symbol: "mqbky.us", note: "US-listed ADR, USD" },
};

export type MarketProxyListing = {
  candidates: { symbol: string; note: string }[];
  kind: "etf" | "adr";
};

// Primary market fallback uses the existing authenticated Alpaca→Polygon
// quote chain. These are separate traded securities, never aliases for the
// underlying index/listing. The note is carried into every prompt and
// deterministic renderer so a proxy return cannot be described as an index
// return. ONEQ and EWA were live-verified through Alpaca on 2026-07-16.
export const MARKET_PROXY_SYMBOLS: Record<string, MarketProxyListing> = {
  GSPC: {
    candidates: [
      {
        symbol: "SPY",
        note: "SPY ETF proxy for the S&P 500; these are SPY returns, not S&P 500 index returns",
      },
    ],
    kind: "etf",
  },
  IXIC: {
    candidates: [
      {
        symbol: "ONEQ",
        note: "ONEQ ETF proxy for the Nasdaq Composite; these are ONEQ returns, not Nasdaq Composite index returns",
      },
      {
        symbol: "QQQ",
        note: "QQQ ETF proxy for the Nasdaq-100; it is not the Nasdaq Composite, and these are QQQ returns",
      },
    ],
    kind: "etf",
  },
  DJI: {
    candidates: [
      {
        symbol: "DIA",
        note: "DIA ETF proxy for the Dow; these are DIA returns, not Dow index returns",
      },
    ],
    kind: "etf",
  },
  AXJO: {
    candidates: [
      {
        symbol: "EWA",
        note: "EWA ETF proxy for broad Australian equities; it is not the ASX 200 or All Ordinaries, and these are EWA returns",
      },
    ],
    kind: "etf",
  },
  CBA: {
    candidates: [
      {
        symbol: "CMWAY",
        note: "CMWAY US OTC ADR in USD; these are ADR returns, not ASX:CBA returns",
      },
    ],
    kind: "adr",
  },
  NAB: {
    candidates: [
      {
        symbol: "NABZY",
        note: "NABZY US OTC ADR in USD; these are ADR returns, not ASX:NAB returns",
      },
    ],
    kind: "adr",
  },
  ANZ: {
    candidates: [
      {
        symbol: "ANZGY",
        note: "ANZGY US OTC ADR in USD; these are ADR returns, not ASX:ANZ returns",
      },
    ],
    kind: "adr",
  },
  WBC: {
    candidates: [
      {
        symbol: "WBKCY",
        note: "WBKCY US OTC ADR in USD; these are ADR returns, not ASX:WBC returns",
      },
    ],
    kind: "adr",
  },
  MQG: {
    candidates: [
      {
        symbol: "MQBKY",
        note: "MQBKY US OTC ADR in USD; these are ADR returns, not ASX:MQG returns",
      },
    ],
    kind: "adr",
  },
};

export const WEB_ALIASES: WebAlias[] = [
  { name: "Apple", query: "Apple AAPL stock financial news", ticker: "AAPL", aliases: ["apple"], market: "us", jurisdiction: "United States" },
  { name: "Microsoft", query: "Microsoft MSFT stock financial news", ticker: "MSFT", aliases: ["microsoft"], market: "us", jurisdiction: "United States" },
  { name: "Nvidia", query: "Nvidia NVDA stock financial news", ticker: "NVDA", aliases: ["nvidia"], market: "us", jurisdiction: "United States" },
  { name: "Alphabet", query: "Alphabet Google GOOGL stock financial news", ticker: "GOOGL", aliases: ["alphabet", "google"], market: "us", jurisdiction: "United States" },
  { name: "Amazon", query: "Amazon AMZN stock financial news", ticker: "AMZN", aliases: ["amazon"], market: "us", jurisdiction: "United States" },
  { name: "Meta Platforms", query: "Meta Platforms META stock financial news", ticker: "META", aliases: ["meta platforms", "meta", "facebook"], market: "us", jurisdiction: "United States" },
  { name: "Tesla", query: "Tesla TSLA stock financial news", ticker: "TSLA", aliases: ["tesla"], market: "us", jurisdiction: "United States" },
  { name: "JPMorgan Chase", query: "JPMorgan Chase JPM stock financial news", ticker: "JPM", aliases: ["jpmorgan chase", "jpmorgan", "jp morgan"], market: "us", jurisdiction: "United States" },
  { name: "Goldman Sachs", query: "Goldman Sachs GS stock financial news", ticker: "GS", aliases: ["goldman sachs", "goldman"], market: "us", jurisdiction: "United States" },
  { name: "S&P 500", query: "S&P 500 GSPC market index", ticker: "GSPC", aliases: ["s&p 500", "s&p500", "sp500", "s and p 500", "the s&p"], market: "index" },
  { name: "Dow Jones Industrial Average", query: "Dow Jones Industrial Average DJI market index", ticker: "DJI", aliases: ["dow jones", "the dow"], market: "index" },
  { name: "All Ordinaries", query: "All Ordinaries ASX Australian share market index", ticker: "AXJO", aliases: ["asx 200", "asx200", "s&p/asx 200", "all ordinaries", "all ords"], market: "index", jurisdiction: "Australia" },
  { name: "StockX", query: "StockX private company sneaker resale marketplace financial news", aliases: ["stockx", "stock x"], jurisdiction: "United States", private: true },
  { name: "Commonwealth Bank", query: "Commonwealth Bank Australia ASX", ticker: "CBA", aliases: ["commonwealth bank", "commbank", "cba"], jurisdiction: "Australia", market: "au" },
  { name: "National Australia Bank", query: "National Australia Bank ASX", ticker: "NAB", aliases: ["national australia bank", "nab"], jurisdiction: "Australia", market: "au" },
  { name: "Macquarie Group", query: "Macquarie Group Australia ASX", ticker: "MQG", aliases: ["macquarie group", "macquarie"], jurisdiction: "Australia", market: "au" },
  { name: "Woolworths Group", query: "Woolworths Group Australia ASX", ticker: "WOW", aliases: ["woolworths group", "woolworths"] },
  { name: "WiseTech Global", query: "WiseTech Global Australia ASX", ticker: "WTC", aliases: ["wisetech global", "wisetech"] },
  { name: "Goodman Group", query: "Goodman Group Australia ASX", ticker: "GMG", aliases: ["goodman group"] },
  { name: "Westpac", query: "Westpac Banking Corporation Australia ASX", ticker: "WBC", aliases: ["westpac"], jurisdiction: "Australia", market: "au" },
  { name: "ANZ Group", query: "ANZ Group Australia ASX", ticker: "ANZ", aliases: ["anz group", "anz"], jurisdiction: "Australia", market: "au" },
  { name: "BHP Group", query: "BHP Group Australia ASX", ticker: "BHP", aliases: ["bhp group", "bhp"] },
  { name: "CSL Limited", query: "CSL Limited Australia ASX", ticker: "CSL", aliases: ["csl limited", "csl"] },
  { name: "Atlassian", query: "Atlassian company financial news", ticker: "TEAM", aliases: ["atlassian"] },
  { name: "SpaceX", query: "SpaceX company financial news", aliases: ["spacex", "space x"], private: true },
  { name: "Nasdaq Composite", query: "Nasdaq Composite IXIC market index", ticker: "IXIC", aliases: ["nasdaq composite", "ixic", "nasdaq"], market: "index" },
  { name: "Fortune 500", query: "Fortune 500 companies revenue ranking", aliases: ["fortune 500"] },
  { name: "Fortune 100", query: "Fortune 100 companies revenue ranking", aliases: ["fortune 100"] },
  { name: "Deloitte", query: "Deloitte global financial performance", aliases: ["deloitte"], private: true },
  { name: "PwC", query: "PwC global financial performance", aliases: ["pwc", "pricewaterhousecoopers"], private: true },
  { name: "EY", query: "EY global financial performance", aliases: ["ey", "ernst and young"], private: true },
  { name: "KPMG", query: "KPMG global financial performance", aliases: ["kpmg"], private: true },
  { name: "DraftKings", query: "DraftKings DKNG earnings financial news", ticker: "DKNG", aliases: ["draftkings", "draft kings"], market: "us", jurisdiction: "United States" },
  { name: "Wesfarmers", query: "Wesfarmers Australia ASX", ticker: "WES", aliases: ["wesfarmers"] },
  { name: "Qantas", query: "Qantas Airways Australia ASX", ticker: "QAN", aliases: ["qantas airways", "qantas"] },
  { name: "Rio Tinto", query: "Rio Tinto Australia ASX", ticker: "RIO", aliases: ["rio tinto"] },
  { name: "Fortescue", query: "Fortescue Australia ASX", ticker: "FMG", aliases: ["fortescue metals", "fortescue"] },
  { name: "Telstra", query: "Telstra Australia ASX", ticker: "TLS", aliases: ["telstra"] },
  { name: "Woodside Energy", query: "Woodside Energy Australia ASX", ticker: "WDS", aliases: ["woodside energy", "woodside"] },
  { name: "REA Group", query: "REA Group Australia ASX", ticker: "REA", aliases: ["rea group"] },
  { name: "Xero", query: "Xero company Australia financial news", ticker: "XRO", aliases: ["xero"] },
  { name: "Aristocrat Leisure", query: "Aristocrat Leisure Australia ASX", ticker: "ALL", aliases: ["aristocrat leisure"] },
  { name: "Samsung Electronics", query: "Samsung Electronics financial news", aliases: ["samsung electronics", "samsung"] },
  { name: "Taiwan Semiconductor", query: "Taiwan Semiconductor TSMC financial news", ticker: "TSM", aliases: ["taiwan semiconductor", "tsmc"] },
  { name: "Toyota", query: "Toyota Motor financial news Japan", ticker: "TM", aliases: ["toyota motor", "toyota"] },
  { name: "Tencent", query: "Tencent Holdings financial news Hong Kong", aliases: ["tencent holdings", "tencent"] },
  { name: "Alibaba", query: "Alibaba Group financial news China", ticker: "BABA", aliases: ["alibaba group", "alibaba"] },
  { name: "Novo Nordisk", query: "Novo Nordisk financial news Denmark", ticker: "NVO", aliases: ["novo nordisk"] },
  { name: "ASML", query: "ASML Holding financial news Netherlands", ticker: "ASML", aliases: ["asml holding", "asml"] },
  { name: "SAP", query: "SAP company financial news Germany", ticker: "SAP", aliases: ["sap"] },
  { name: "Siemens", query: "Siemens financial news Germany", aliases: ["siemens"] },
];

export const PRIVATE_COMPANY_NAMES = new Set(
  WEB_ALIASES.filter((alias) => alias.private).map((alias) => alias.name)
);

export type CanonicalGroup = {
  id: string;
  version: 1;
  aliases: RegExp;
  members: string[];
};

export const CANONICAL_GROUPS: CanonicalGroup[] = [
  {
    id: "professional-services-big-four",
    version: 1,
    aliases:
      /\b(?:(?:consulting|consultancy|accounting|audit|professional services)\s+big\s*(?:4|four)|big\s*(?:4|four)\s+(?:consulting|consultanc(?:y|ies)|consultants?|accounting|accountants?|audit(?:ors?)?|professional services|firms))\b/i,
    members: ["Deloitte", "PwC", "EY", "KPMG"],
  },
  {
    id: "australian-big-four",
    version: 1,
    aliases:
      /(?<!(?:other|another)\s)\b(?:(?:(?:australian|aussie|asx)\s+)?big\s*(?:4|four)(?:\s+(?:(?:australian|aussie|asx)\s+)?banks?)?|(?:australian|aussie)\s+banks)\b/i,
    members: ["CBA", "NAB", "ANZ", "WBC"],
  },
  {
    id: "magnificent-seven",
    version: 1,
    aliases: /\b(?:mag\s*7|magnificent\s+(?:7|seven))\b/i,
    members: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA"],
  },
];

export const LISTING_NAMES: Record<string, string> = {
  ASX: "ASX",
  AX: "ASX",
  LSE: "London Stock Exchange",
  L: "London Stock Exchange",
  TSX: "Toronto Stock Exchange",
  TO: "Toronto Stock Exchange",
  HKEX: "Hong Kong Stock Exchange",
  HK: "Hong Kong Stock Exchange",
  TSE: "Tokyo Stock Exchange",
  T: "Tokyo Stock Exchange",
  NSE: "National Stock Exchange of India",
  NS: "National Stock Exchange of India",
  BSE: "Bombay Stock Exchange",
  BO: "Bombay Stock Exchange",
};

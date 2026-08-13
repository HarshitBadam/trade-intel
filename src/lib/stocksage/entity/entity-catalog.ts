export type WebAlias = {
  name: string;
  query: string;
  ticker?: string;
  aliases: string[];
  jurisdiction?: string;
  market?: "us" | "web" | "index" | "au";
  private?: true;
};

export const WEB_ALIASES: WebAlias[] = [
  { name: "Apple", query: "Apple AAPL stock financial news", ticker: "AAPL", aliases: ["apple"], market: "us", jurisdiction: "United States" },
  { name: "Microsoft", query: "Microsoft MSFT stock financial news", ticker: "MSFT", aliases: ["microsoft"], market: "us", jurisdiction: "United States" },
  { name: "Nvidia", query: "Nvidia NVDA stock financial news", ticker: "NVDA", aliases: ["nvidia"], market: "us", jurisdiction: "United States" },
  { name: "Alphabet", query: "Alphabet Google GOOGL stock financial news", ticker: "GOOGL", aliases: ["alphabet", "google"], market: "us", jurisdiction: "United States" },
  { name: "Berkshire Hathaway", query: "Berkshire Hathaway BRK.A stock financial news", ticker: "BRK.A", aliases: ["berkshire hathaway", "berkshire hathway"], market: "us", jurisdiction: "United States" },
  { name: "Amazon", query: "Amazon AMZN stock financial news", ticker: "AMZN", aliases: ["amazon"], market: "us", jurisdiction: "United States" },
  { name: "Meta Platforms", query: "Meta Platforms META stock financial news", ticker: "META", aliases: ["meta platforms", "meta", "facebook"], market: "us", jurisdiction: "United States" },
  { name: "Tesla", query: "Tesla TSLA stock financial news", ticker: "TSLA", aliases: ["tesla"], market: "us", jurisdiction: "United States" },
  { name: "JPMorgan Chase", query: "JPMorgan Chase JPM stock financial news", ticker: "JPM", aliases: ["jpmorgan chase", "jpmorgan", "jp morgan"], market: "us", jurisdiction: "United States" },
  { name: "Goldman Sachs", query: "Goldman Sachs GS stock financial news", ticker: "GS", aliases: ["goldman sachs", "goldman"], market: "us", jurisdiction: "United States" },
  { name: "Caterpillar", query: "Caterpillar CAT stock financial news", ticker: "CAT", aliases: ["caterpillar"], market: "us", jurisdiction: "United States" },
  { name: "SanDisk", query: "SanDisk SNDK stock financial news", ticker: "SNDK", aliases: ["sandisk", "san disk"], market: "us", jurisdiction: "United States" },
  { name: "S&P 500", query: "S&P 500 GSPC market index", ticker: "GSPC", aliases: ["s&p 500", "s&p500", "sp500", "s and p 500", "the s&p"], market: "index" },
  { name: "Dow Jones Industrial Average", query: "Dow Jones Industrial Average DJI market index", ticker: "DJI", aliases: ["dow jones", "the dow"], market: "index" },
  { name: "S&P/ASX 200", query: "S&P/ASX 200 AXJO Australian share market index", ticker: "AXJO", aliases: ["asx 200", "asx200", "s&p/asx 200", "the asx", "australian share market"], market: "index", jurisdiction: "Australia" },
  { name: "StockX", query: "StockX private company sneaker resale marketplace financial news", aliases: ["stockx", "stock x"], jurisdiction: "United States", private: true },
  { name: "Commonwealth Bank", query: "Commonwealth Bank Australia ASX", ticker: "CBA", aliases: ["commonwealth bank", "commbank", "cba"], jurisdiction: "Australia", market: "au" },
  { name: "National Australia Bank", query: "National Australia Bank ASX", ticker: "NAB", aliases: ["national australia bank", "nab"], jurisdiction: "Australia", market: "au" },
  { name: "Macquarie Group", query: "Macquarie Group Australia ASX", ticker: "MQG", aliases: ["macquarie group", "macquarie"], jurisdiction: "Australia", market: "au" },
  { name: "Woolworths Group", query: "Woolworths Group Australia ASX", ticker: "WOW", aliases: ["woolworths group", "woolworths"], jurisdiction: "Australia", market: "au" },
  { name: "WiseTech Global", query: "WiseTech Global Australia ASX", ticker: "WTC", aliases: ["wisetech global", "wisetech"], jurisdiction: "Australia", market: "au" },
  { name: "Goodman Group", query: "Goodman Group Australia ASX", ticker: "GMG", aliases: ["goodman group"], jurisdiction: "Australia", market: "au" },
  { name: "Westpac", query: "Westpac Banking Corporation Australia ASX", ticker: "WBC", aliases: ["westpac"], jurisdiction: "Australia", market: "au" },
  { name: "ANZ Group", query: "ANZ Group Australia ASX", ticker: "ANZ", aliases: ["anz group", "anz"], jurisdiction: "Australia", market: "au" },
  { name: "BHP Group", query: "BHP Group Australia ASX", ticker: "BHP", aliases: ["bhp group", "bhp"], jurisdiction: "Australia", market: "au" },
  { name: "CSL Limited", query: "CSL Limited Australia ASX", ticker: "CSL", aliases: ["csl limited", "csl"], jurisdiction: "Australia", market: "au" },
  { name: "Atlassian", query: "Atlassian company financial news", ticker: "TEAM", aliases: ["atlassian"] },
  { name: "SpaceX", query: "SpaceX SPCX stock financial news", ticker: "SPCX", aliases: ["spacex", "space x"], market: "us", jurisdiction: "United States" },
  { name: "Nasdaq Composite", query: "Nasdaq Composite IXIC market index", ticker: "IXIC", aliases: ["nasdaq composite", "ixic", "nasdaq"], market: "index" },
  { name: "Fortune 500", query: "Fortune 500 companies revenue ranking", aliases: ["fortune 500"] },
  { name: "Fortune 100", query: "Fortune 100 companies revenue ranking", aliases: ["fortune 100"] },
  { name: "Deloitte", query: "Deloitte global financial performance", aliases: ["deloitte"], private: true },
  { name: "PwC", query: "PwC global financial performance", aliases: ["pwc", "pricewaterhousecoopers"], private: true },
  { name: "EY", query: "EY global financial performance", aliases: ["ey", "ernst and young"], private: true },
  { name: "KPMG", query: "KPMG global financial performance", aliases: ["kpmg", "kmpg"], private: true },
  { name: "DraftKings", query: "DraftKings DKNG earnings financial news", ticker: "DKNG", aliases: ["draftkings", "draft kings"], market: "us", jurisdiction: "United States" },
  { name: "Wesfarmers", query: "Wesfarmers Australia ASX", ticker: "WES", aliases: ["wesfarmers"], jurisdiction: "Australia", market: "au" },
  { name: "Qantas", query: "Qantas Airways Australia ASX", ticker: "QAN", aliases: ["qantas airways", "qantas"], jurisdiction: "Australia", market: "au" },
  { name: "Rio Tinto", query: "Rio Tinto Australia ASX", ticker: "RIO", aliases: ["rio tinto"], jurisdiction: "Australia", market: "au" },
  { name: "Fortescue", query: "Fortescue Australia ASX", ticker: "FMG", aliases: ["fortescue metals", "fortescue"], jurisdiction: "Australia", market: "au" },
  { name: "Telstra", query: "Telstra Australia ASX", ticker: "TLS", aliases: ["telstra"], jurisdiction: "Australia", market: "au" },
  { name: "Woodside Energy", query: "Woodside Energy Australia ASX", ticker: "WDS", aliases: ["woodside energy", "woodside"], jurisdiction: "Australia", market: "au" },
  { name: "REA Group", query: "REA Group Australia ASX", ticker: "REA", aliases: ["rea group"], jurisdiction: "Australia", market: "au" },
  { name: "Xero", query: "Xero company Australia financial news", ticker: "XRO", aliases: ["xero"], jurisdiction: "Australia", market: "au" },
  { name: "Aristocrat Leisure", query: "Aristocrat Leisure Australia ASX", ticker: "ALL", aliases: ["aristocrat leisure"], jurisdiction: "Australia", market: "au" },
  { name: "Samsung Electronics", query: "Samsung Electronics financial news", aliases: ["samsung electronics", "samsung"] },
  { name: "Taiwan Semiconductor", query: "Taiwan Semiconductor TSMC financial news", ticker: "TSM", aliases: ["taiwan semiconductor", "tsmc"], market: "us", jurisdiction: "Taiwan" },
  { name: "Toyota", query: "Toyota Motor financial news Japan", ticker: "TM", aliases: ["toyota motor", "toyota"] },
  { name: "Tencent", query: "Tencent Holdings financial news Hong Kong", aliases: ["tencent holdings", "tencent"] },
  { name: "Alibaba", query: "Alibaba Group financial news China", ticker: "BABA", aliases: ["alibaba group", "alibaba"] },
  { name: "Novo Nordisk", query: "Novo Nordisk financial news Denmark", ticker: "NVO", aliases: ["novo nordisk"] },
  { name: "ASML", query: "ASML Holding financial news Netherlands", ticker: "ASML", aliases: ["asml holding", "asml"], market: "us", jurisdiction: "Netherlands" },
  { name: "SAP", query: "SAP company financial news Germany", ticker: "SAP", aliases: ["sap"] },
  { name: "Siemens", query: "Siemens financial news Germany", aliases: ["siemens"] },
];

export type CanonicalGroup = {
  id: string;
  version: 1;
  label: string;
  aliases: RegExp;
  members: string[];
};

export const CANONICAL_GROUPS: CanonicalGroup[] = [
  {
    id: "professional-services-big-four",
    version: 1,
    label: "the professional-services Big Four",
    aliases:
      /\b(?:(?:consulting|consultancy|accounting|audit|professional services)\s+big\s*(?:4|four)|big\s*(?:4|four)\s+(?:consulting|consultanc(?:y|ies)|consultants?|accounting|accountants?|audit(?:ors?)?|professional services|firms))\b/i,
    members: ["Deloitte", "PwC", "EY", "KPMG"],
  },
  {
    id: "australian-big-four",
    version: 1,
    label: "the Australian Big Four banks",
    aliases:
      /(?<!(?:other|another)\s)\b(?:(?:(?:australian|aussie|asx)\s+)?big\s*(?:4|four)(?:\s+(?:(?:australian|aussie|asx)\s+)?banks?)?|(?:australian|aussie)\s+banks)\b/i,
    members: ["CBA", "NAB", "ANZ", "WBC"],
  },
  {
    id: "magnificent-seven",
    version: 1,
    label: "the Magnificent Seven",
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

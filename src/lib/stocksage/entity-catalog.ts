export type WebAlias = {
  name: string;
  query: string;
  ticker?: string;
  aliases: string[];
  jurisdiction?: string;
  market?: "us" | "web";
};

export const WEB_ALIASES: WebAlias[] = [
  { name: "Commonwealth Bank", query: "Commonwealth Bank Australia ASX", ticker: "CBA", aliases: ["commonwealth bank", "commbank", "cba"], jurisdiction: "Australia" },
  { name: "National Australia Bank", query: "National Australia Bank ASX", ticker: "NAB", aliases: ["national australia bank", "nab"], jurisdiction: "Australia" },
  { name: "Macquarie Group", query: "Macquarie Group Australia ASX", ticker: "MQG", aliases: ["macquarie group", "macquarie"], jurisdiction: "Australia" },
  { name: "Woolworths Group", query: "Woolworths Group Australia ASX", ticker: "WOW", aliases: ["woolworths group", "woolworths"] },
  { name: "WiseTech Global", query: "WiseTech Global Australia ASX", ticker: "WTC", aliases: ["wisetech global", "wisetech"] },
  { name: "Goodman Group", query: "Goodman Group Australia ASX", ticker: "GMG", aliases: ["goodman group"] },
  { name: "Westpac", query: "Westpac Banking Corporation Australia ASX", ticker: "WBC", aliases: ["westpac"], jurisdiction: "Australia" },
  { name: "ANZ Group", query: "ANZ Group Australia ASX", ticker: "ANZ", aliases: ["anz group", "anz"], jurisdiction: "Australia" },
  { name: "BHP Group", query: "BHP Group Australia ASX", ticker: "BHP", aliases: ["bhp group", "bhp"] },
  { name: "CSL Limited", query: "CSL Limited Australia ASX", ticker: "CSL", aliases: ["csl limited", "csl"] },
  { name: "Atlassian", query: "Atlassian company financial news", ticker: "TEAM", aliases: ["atlassian"] },
  { name: "SpaceX", query: "SpaceX company financial news", aliases: ["spacex", "space x"] },
  { name: "Nasdaq Composite", query: "Nasdaq Composite IXIC market index", ticker: "IXIC", aliases: ["nasdaq composite", "ixic"] },
  { name: "Fortune 500", query: "Fortune 500 companies revenue ranking", aliases: ["fortune 500"] },
  { name: "Fortune 100", query: "Fortune 100 companies revenue ranking", aliases: ["fortune 100"] },
  { name: "Deloitte", query: "Deloitte global financial performance", aliases: ["deloitte"] },
  { name: "PwC", query: "PwC global financial performance", aliases: ["pwc", "pricewaterhousecoopers"] },
  { name: "EY", query: "EY global financial performance", aliases: ["ey", "ernst and young"] },
  { name: "KPMG", query: "KPMG global financial performance", aliases: ["kpmg"] },
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

export type CanonicalGroup = {
  id: string;
  version: 1;
  aliases: RegExp;
  members: string[];
};

export const CANONICAL_GROUPS: CanonicalGroup[] = [
  {
    id: "australian-big-four",
    version: 1,
    aliases:
      /\b(?:(?:australian|aussie|asx)\s+big\s*(?:4|four)(?:\s+(?:australian|aussie))?\s+banks?|big\s*(?:4|four)(?:\s+(?:australian|aussie|asx))?\s+banks?)\b/i,
    members: ["CBA", "NAB", "ANZ", "WBC"],
  },
  {
    id: "professional-services-big-four",
    version: 1,
    aliases:
      /\b(?:(?:consulting|accounting|professional services)\s+big\s*(?:4|four)|big\s*(?:4|four)\s+(?:consulting|accounting|professional services))\b/i,
    members: ["Deloitte", "PwC", "EY", "KPMG"],
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

import "server-only";

import { isInUniverse, searchUniverse } from "@/lib/market-data";
import { resolveTickers } from "@/lib/tickers";
import type { ChatTurn, FinanceEntity } from "./types";

type WebAlias = {
  name: string;
  query: string;
  ticker?: string;
  aliases: string[];
};

const WEB_ALIASES: WebAlias[] = [
  { name: "Commonwealth Bank", query: "Commonwealth Bank Australia ASX", ticker: "CBA", aliases: ["commonwealth bank", "commbank", "cba"] },
  { name: "National Australia Bank", query: "National Australia Bank ASX", ticker: "NAB", aliases: ["national australia bank", "nab"] },
  { name: "Macquarie Group", query: "Macquarie Group Australia ASX", ticker: "MQG", aliases: ["macquarie group", "macquarie"] },
  { name: "Woolworths Group", query: "Woolworths Group Australia ASX", ticker: "WOW", aliases: ["woolworths group", "woolworths"] },
  { name: "WiseTech Global", query: "WiseTech Global Australia ASX", ticker: "WTC", aliases: ["wisetech global", "wisetech"] },
  { name: "Goodman Group", query: "Goodman Group Australia ASX", ticker: "GMG", aliases: ["goodman group"] },
  { name: "Westpac", query: "Westpac Banking Corporation Australia ASX", ticker: "WBC", aliases: ["westpac"] },
  { name: "ANZ Group", query: "ANZ Group Australia ASX", ticker: "ANZ", aliases: ["anz group", "anz"] },
  { name: "BHP Group", query: "BHP Group Australia ASX", ticker: "BHP", aliases: ["bhp group", "bhp"] },
  { name: "CSL Limited", query: "CSL Limited Australia ASX", ticker: "CSL", aliases: ["csl limited", "csl"] },
  { name: "Atlassian", query: "Atlassian company financial news", ticker: "TEAM", aliases: ["atlassian"] },
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

const LISTING_NAMES: Record<string, string> = {
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

const FOLLOW_UP_REFERENCE =
  /\b(?:it|its|they|their|them|that|this|those|these|former|latter|first one|second one|that one|this one|the company|the stock|the shares|what about|how about|compared to|relative to)\b/i;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAlias(text: string, alias: string): boolean {
  return new RegExp(`\\b${escaped(alias)}\\b`, "i").test(text);
}

function addEntity(
  output: FinanceEntity[],
  seen: Set<string>,
  entity: FinanceEntity
): void {
  const key = `${entity.market}:${entity.ticker ?? entity.name}`.toUpperCase();
  if (seen.has(key)) return;
  seen.add(key);
  output.push(entity);
}

function resolveText(text: string): FinanceEntity[] {
  const clean = text.replace(/\bhey\s*,?\s*sage\b/gi, " ");
  const output: FinanceEntity[] = [];
  const seen = new Set<string>();
  const webTickers = new Set<string>();

  for (const alias of WEB_ALIASES) {
    if (!alias.aliases.some((candidate) => hasAlias(clean, candidate))) continue;
    if (alias.ticker) webTickers.add(alias.ticker);
    addEntity(output, seen, {
      name: alias.name,
      query: alias.query,
      ticker: alias.ticker,
      market: "web",
    });
  }

  const prefixed = /\b(ASX|LSE|TSX|HKEX|TSE|NSE|BSE)\s*:\s*([A-Z0-9]{1,6})\b/gi;
  for (const match of clean.matchAll(prefixed)) {
    const listing = match[1].toUpperCase();
    const ticker = match[2].toUpperCase();
    webTickers.add(ticker);
    addEntity(output, seen, {
      name: `${listing}:${ticker}`,
      query: `${ticker} ${LISTING_NAMES[listing]} company`,
      ticker,
      market: "web",
    });
  }

  const suffixed = /\b([A-Z0-9]{1,6})\.(AX|L|TO|HK|T|NS|BO)\b/gi;
  for (const match of clean.matchAll(suffixed)) {
    const ticker = match[1].toUpperCase();
    const suffix = match[2].toUpperCase();
    webTickers.add(ticker);
    addEntity(output, seen, {
      name: `${ticker}.${suffix}`,
      query: `${ticker} ${LISTING_NAMES[suffix]} company`,
      ticker,
      market: "web",
    });
  }

  for (const ticker of resolveTickers(clean, 8)) {
    if (webTickers.has(ticker) || !isInUniverse(ticker)) continue;
    const marker = "\\b(?:australian|australia|asx|non-us|foreign)\\b";
    const symbol = `\\b${escaped(ticker)}\\b`;
    const nearbyNonUs = new RegExp(
      `(?:${marker}.{0,40}${symbol}|${symbol}.{0,40}${marker})`,
      "i"
    ).test(clean);
    if (nearbyNonUs) {
      addEntity(output, seen, {
        name: ticker,
        query: `${ticker} company financial news`,
        ticker,
        market: "web",
      });
      continue;
    }
    const match = searchUniverse(ticker, 1)[0];
    const name = match?.name ?? ticker;
    addEntity(output, seen, {
      name,
      query: `${name} ${ticker}`,
      ticker,
      market: "us",
    });
  }

  return output.slice(0, 6);
}

export function resolveFinanceEntities(
  message: string,
  history: ChatTurn[]
): FinanceEntity[] {
  const current = resolveText(message);
  if (current.length > 0) return current;
  if (!FOLLOW_UP_REFERENCE.test(message)) return [];
  for (const turn of [...history].reverse()) {
    if (turn.role !== "user") continue;
    const prior = resolveText(turn.text);
    if (prior.length > 0) return prior;
  }
  return [];
}

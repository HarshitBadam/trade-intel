import type { ChatRequest } from "../types";
import type { RankingMarket } from "./contracts";

export function compactHistory(request: ChatRequest): string {
  return request.history
    .slice(-6)
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.slice(0, 700)}`
    )
    .join("\n");
}

export function isoToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function semanticContext(
  request: ChatRequest,
  now = new Date()
): string {
  const entities = request.state?.entities.map((entity) => ({
    name: entity.name,
    ticker: entity.ticker,
    private: entity.private,
  }));
  return JSON.stringify({
    today: isoToday(now),
    activeEntities: entities ?? [],
    focusEntityIds: request.state?.focusEntityIds ?? [],
    priorIntervals: request.state?.intervals ?? [],
    conversation: compactHistory(request),
    currentMessage: request.message,
  });
}

const ASX_MARKET_MENTION =
  /\basx\b|\basx\s?200\b|\baustralia\b|\baustralian\b|\baussie\b/i;
const US_MARKET_NOUN = "market|stocks?|shares?|performers?|gainers?|losers?|movers?|companies|equities";
const US_MARKET_MENTION = new RegExp(
  `\\bu\\.s\\.?\\b|\\busa\\b|\\bunited states\\b|\\bamerican?\\b|\\bnyse\\b|\\bnasdaq\\b|\\bwall street\\b|\\bs&p\\s*500\\b|\\bspx\\b|\\bus\\s+(?:${US_MARKET_NOUN})\\b|\\b\\d{1,3}\\s+us\\b`,
  "i"
);
const US_THEN_ASX =
  /\bus\s*(?:,|and|&)\s*(?:the\s+)?(?:asx|australia|australian)\b/i;
const ASX_THEN_US =
  /\b(?:asx|australia|australian)\s*(?:,|and|&)\s*(?:the\s+)?us\b/i;

function pairedUsIndex(message: string): number {
  for (const pattern of [US_THEN_ASX, ASX_THEN_US]) {
    const pair = pattern.exec(message);
    if (pair?.index === undefined) continue;
    const offset = pair[0].search(/\bus\b/i);
    if (offset >= 0) return pair.index + offset;
  }
  return -1;
}

function explicitRankingMarkets(message: string): Array<"US" | "ASX"> {
  const asxIndex = message.search(ASX_MARKET_MENTION);
  const directUsIndex = message.search(US_MARKET_MENTION);
  const usIndex =
    directUsIndex >= 0 ? directUsIndex : pairedUsIndex(message);
  return [
    ...(usIndex >= 0 ? [{ market: "US" as const, index: usIndex }] : []),
    ...(asxIndex >= 0 ? [{ market: "ASX" as const, index: asxIndex }] : []),
  ]
    .sort((left, right) => left.index - right.index)
    .map(({ market }) => market);
}

export function explicitRankingMarketMention(
  message: string
): "US" | "ASX" | undefined {
  return explicitRankingMarkets(message)[0];
}

export function deterministicRankingMarkets(
  request: ChatRequest
): RankingMarket[] {
  const explicit = explicitRankingMarkets(request.message);
  if (explicit.length > 0) return explicit;
  if (request.state?.jurisdiction === "Australia") return ["ASX"];
  if (request.state?.entities.some((entity) => entity.market === "au")) {
    return ["ASX"];
  }
  return ["US"];
}

export function deterministicRankingMarket(request: ChatRequest): RankingMarket {
  return deterministicRankingMarkets(request)[0];
}

const RANKING_INTENT_PATTERN =
  /\b(?:top|bottom)\b[^.!?\n]{0,40}\bperformers?\b|\btop\s+\d{1,3}\b|\bbottom\s+\d{1,3}\b|\b(?:best|worst)\s+performers?\b|\bgainers?\b|\blosers?\b|\bmovers?\b/i;

export function hasMarketWideRankingIntent(message: string): boolean {
  return RANKING_INTENT_PATTERN.test(message);
}

const MIXED_INTENT_SIGNAL =
  /\bhow\s+(?:is|are|was|were)\b|\bwhat\s+about\b|\bcompare\b|\bversus\b|\bvs\.?\b|\bnews\b|\bprice\b|\bquote\b|\bperformance\b|\bstory\b|\ballegations?\b|\bannouncements?\b|\breports?\b|\bearnings\b|\blawsuit\b|\binvestigation\b|\$[a-z]{1,6}\b/i;

const RANKING_PAIR_CONJUNCTIONS = [
  /\btop\s+and\s+bottom\b/gi,
  /\bbottom\s+and\s+top\b/gi,
  /\bbest\s+and\s+worst\b/gi,
  /\bworst\s+and\s+best\b/gi,
  /\bgainers?\s+and\s+losers?\b/gi,
  /\blosers?\s+and\s+gainers?\b/gi,
  /\bwinners?\s+and\s+losers?\b/gi,
  /\bus\s*(?:,|and|&)\s*(?:the\s+)?(?:asx|australia|australian)\b/gi,
  /\b(?:asx|australia|australian)\s*(?:,|and|&)\s*(?:the\s+)?us\b/gi,
];

const RESIDUAL_ADDITIVE_CLAUSE =
  /\band\b|,|\balso\b|\bas well as\b|\bplus\b/i;

function hasResidualAdditiveClause(message: string): boolean {
  const stripped = RANKING_PAIR_CONJUNCTIONS.reduce(
    (text, pattern) => text.replace(pattern, " "),
    message
  );
  return RESIDUAL_ADDITIVE_CLAUSE.test(stripped);
}

const SAFE_ALL_CAPS_TOKENS = new Set([
  "US",
  "USA",
  "ASX",
  "NYSE",
  "NASDAQ",
  "SPX",
  "YTD",
  "ETF",
]);

function hasLikelyTickerToken(message: string): boolean {
  const tokens = message.match(/\b[A-Z]{2,5}\b/g) ?? [];
  return tokens.some((token) => !SAFE_ALL_CAPS_TOKENS.has(token));
}

export function isUnambiguousMarketWideRankingTurn(message: string): boolean {
  if (!hasMarketWideRankingIntent(message)) return false;
  if (MIXED_INTENT_SIGNAL.test(message)) return false;
  if (hasResidualAdditiveClause(message)) return false;
  if (hasLikelyTickerToken(message)) return false;
  return true;
}

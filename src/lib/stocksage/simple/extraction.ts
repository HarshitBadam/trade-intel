import { z, ZodError } from "zod";
import { llmErrorSummary } from "@/lib/llm";
import { logStockSage } from "@/lib/telemetry";
import type { ChatRequest } from "../types";
import type { RankingMarket, RankingRequest, SimpleEvidencePlan } from "./contracts";
import {
  deterministicRankingMarkets,
  hasMarketWideRankingIntent,
  isoToday,
  isUnambiguousMarketWideRankingTurn,
  semanticContext,
} from "./context";
import {
  isRecoverableLlmTransportFailure,
  simpleLlmChatJSON,
  type SimpleJsonCall,
} from "./llm";
import {
  NewsQuerySchema,
  normalizeSimpleEvidencePlan,
  RankingTupleSchema,
  SubjectDatePairSchema,
  summarizeZodIssues,
} from "./validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function salvageBoundedList<T>(
  value: unknown,
  schema: z.ZodType<T>,
  max: number
): T[] {
  if (!Array.isArray(value)) return [];
  const salvaged: T[] = [];
  for (const entry of value) {
    if (salvaged.length >= max) break;
    const parsed = schema.safeParse(entry);
    if (parsed.success) salvaged.push(parsed.data);
  }
  return salvaged;
}

const RANKING_MARKET_ALIASES: Record<string, "US" | "ASX"> = {
  us: "US",
  usa: "US",
  "united states": "US",
  america: "US",
  american: "US",
  nyse: "US",
  nasdaq: "US",
  "wall street": "US",
  "s&p 500": "US",
  spx: "US",
  sp500: "US",
  asx: "ASX",
  au: "ASX",
  "asx 200": "ASX",
  asx200: "ASX",
  australia: "ASX",
  australian: "ASX",
  aussie: "ASX",
};

const RANKING_DATE_DESCRIPTORS = new Set([
  "ytd",
  "year to date",
  "year-to-date",
  "today",
  "now",
  "current",
  "this year",
]);

function coerceRankingMarket(value: unknown): RankingMarket | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "unspecified") return "UNSPECIFIED";
  if (normalized === "us" || normalized === "asx") {
    return normalized.toUpperCase() as RankingMarket;
  }
  return RANKING_MARKET_ALIASES[normalized];
}

function coerceRankingDate(value: unknown, now: Date): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (RANKING_DATE_DESCRIPTORS.has(trimmed.toLowerCase())) return isoToday(now);
  return trimmed;
}

function coerceRankingEntry(entry: unknown, now: Date): RankingRequest | undefined {
  let market: unknown;
  let date: unknown;
  if (Array.isArray(entry) && entry.length >= 2) {
    [market, date] = entry;
  } else if (isRecord(entry)) {
    market = entry.market;
    date = entry.date ?? entry.endDate ?? entry.startDate;
  } else {
    return undefined;
  }
  const coercedMarket = coerceRankingMarket(market);
  const coercedDate = coerceRankingDate(date, now);
  if (!coercedMarket || !coercedDate) return undefined;
  const candidate: RankingRequest = [coercedMarket, coercedDate];
  return RankingTupleSchema.safeParse(candidate).success ? candidate : undefined;
}

function salvageRankings(raw: unknown, now: Date): RankingRequest[] {
  const value = isRecord(raw) ? raw.rankings : undefined;
  if (!Array.isArray(value)) return [];
  const salvaged: RankingRequest[] = [];
  for (const entry of value) {
    if (salvaged.length >= 2) break;
    const coerced = coerceRankingEntry(entry, now);
    if (coerced) salvaged.push(coerced);
  }
  return salvaged;
}

function deterministicRankingSeeds(
  request: ChatRequest,
  now: Date
): RankingRequest[] {
  return deterministicRankingMarkets(request).map((market) => [
    market,
    isoToday(now),
  ]);
}

function salvageEvidencePlan(
  raw: unknown,
  request: ChatRequest,
  now: Date
): SimpleEvidencePlan {
  const prices = salvageBoundedList(
    isRecord(raw) ? raw.prices : undefined,
    SubjectDatePairSchema,
    24
  );
  const news = salvageBoundedList(
    isRecord(raw) ? raw.news : undefined,
    NewsQuerySchema,
    3
  );
  let rankings = salvageRankings(raw, now);
  const rankingIntent = hasMarketWideRankingIntent(request.message);
  if (rankingIntent) {
    const deterministic = deterministicRankingSeeds(request, now);
    if (deterministic.length > 1) {
      rankings = deterministic.map(
        ([market, date]) =>
          rankings.find(([salvagedMarket]) => salvagedMarket === market) ?? [
            market,
            date,
          ]
      );
    } else if (rankings.length === 0) {
      rankings = deterministic;
    }
  }
  if (
    rankingIntent &&
    !isUnambiguousMarketWideRankingTurn(request.message) &&
    prices.length === 0 &&
    news.length === 0
  ) {
    throw new Error(
      "extractEvidencePlan: mixed evidence could not be safely salvaged"
    );
  }
  if (prices.length === 0 && news.length === 0 && rankings.length === 0) {
    throw new Error(
      "extractEvidencePlan: no salvageable evidence in malformed extraction output"
    );
  }
  return normalizeSimpleEvidencePlan({ prices, news, rankings });
}

export async function extractEvidencePlan(
  request: ChatRequest,
  now = new Date(),
  jsonCall: SimpleJsonCall = simpleLlmChatJSON
): Promise<SimpleEvidencePlan> {
  const args = {
    maxTokens: 800,
    temperature: 0,
    timeoutMs: 12_000,
    system: `You are the semantic extraction stage of a financial research assistant.
Return only {"prices":[["subject","YYYY-MM-DD"], ...],"news":["focused search query", ...],"rankings":[["US"|"ASX"|"UNSPECIFIED","YYYY-MM-DD"], ...]}.

The three arrays request factual evidence. Request only evidence needed to answer the user's actual question.

prices is the primary financial-evidence lane. Each entry retrieves available market prices and broad financial news for this subject at this date.
- Always include every named or conversationally referenced financial subject in prices, including when news is also populated.
- For a listed security, subject must be its canonical ticker without "$".
- For a private company, industry, concept, index, or unresolved group, use its concise canonical name. A listed price does not need to exist.
- Resolve former/latter, it/they/them, misspellings, and follow-up dates from the supplied conversation and active entities.
- Preserve the user's semantic order. Duplicate subjects are expected when multiple dates matter.
- For "doing", performance, movement, or comparison questions, emit a useful baseline date and end date for every subject.
- For an exact-date lookup, emit that date. For a period, emit its start and end.
- For monthly, quarterly, or other sampled-series requests, emit only the range start and range end for each subject. The backend samples the intervening sessions.
- For causal/current-news questions, emit the relevant period boundaries.

news is supplemental. Populate it only when the user asks about a specific named story, allegation, announcement, report, lawsuit, investigation, or event. Write a concise standalone search query. Do not use news for ordinary price, performance, comparison, "why", or general company-news questions.

rankings is only for market-wide top, bottom, best, worst, gainers, losers, or movers. The product's default ranking market is US. Use US when the user does not name a market. Use ASX only when it is explicit in the current request or was explicitly established in the supplied conversation. Ranking named companies against one another belongs in prices, not rankings.
- For a pure market-wide ranking request, leave prices empty even when the ranking includes a sector or industry qualifier. Add prices only for a separately requested named security or index.
- A general market overview, trend, or news request is not a ranking. For a general ASX or Australian share-market request, use AXJO in prices.

Examples:
- "How is Apple doing?" -> {"prices":[["AAPL","${isoToday(now)}"]],"news":[],"rankings":[]}
- "Latest general news on SpaceX" -> {"prices":[["SpaceX","${isoToday(now)}"]],"news":[],"rankings":[]}
- "What about the Macquarie whistleblower story?" -> {"prices":[["MQG","${isoToday(now)}"]],"news":["Macquarie whistleblower allegations"],"rankings":[]}
- "Rank Apple against Microsoft" -> {"prices":[["AAPL","${isoToday(now)}"],["MSFT","${isoToday(now)}"]],"news":[],"rankings":[]}
- "Top and bottom US performers today" -> {"prices":[],"news":[],"rankings":[["US","${isoToday(now)}"]]}
- "Top and bottom performers today" -> {"prices":[],"news":[],"rankings":[["US","${isoToday(now)}"]]}
- "What can you tell me about the ASX generally?" -> {"prices":[["AXJO","${isoToday(now)}"]],"news":[],"rankings":[]}

Never invent a ticker. If the request has no finance-research subject or market request, return all three arrays empty. Do not answer the question and do not add fields.`,
    user: semanticContext(request, now),
  };

  let raw: unknown;
  try {
    raw = await jsonCall(args);
  } catch (error) {
    if (
      !isRecoverableLlmTransportFailure(error) ||
      !isUnambiguousMarketWideRankingTurn(request.message)
    ) {
      throw error;
    }
    logStockSage({
      event: "simple_extraction_recovered",
      reasonCode: "transport_failure_deterministic_ranking",
      detail: JSON.stringify(llmErrorSummary(error)),
    });
    return normalizeSimpleEvidencePlan({
      prices: [],
      news: [],
      rankings: deterministicRankingSeeds(request, now),
    });
  }

  try {
    return normalizeSimpleEvidencePlan(raw);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const salvaged = salvageEvidencePlan(raw, request, now);
    logStockSage({
      event: "simple_extraction_recovered",
      reasonCode: "schema_mismatch_salvaged",
      detail: JSON.stringify({
        ...summarizeZodIssues(error),
        yields: {
          prices: salvaged.prices.length,
          news: salvaged.news.length,
          rankings: salvaged.rankings.length,
        },
      }),
    });
    return salvaged;
  }
}

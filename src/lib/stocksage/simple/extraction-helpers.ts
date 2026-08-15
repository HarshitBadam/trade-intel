import { z } from "zod";
import type { ChatRequest } from "../types";
import type { RankingMarket, RankingRequest, SimpleEvidencePlan } from "./contracts";
import {
  deterministicRankingMarkets,
  hasMarketWideRankingIntent,
  isoToday,
  isUnambiguousMarketWideRankingTurn,
} from "./context";
import {
  NewsQuerySchema,
  normalizeSimpleEvidencePlan,
  PricePairsSchema,
  RankingTupleSchema,
  SubjectDatePairSchema,
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

export function deterministicRankingSeeds(
  request: ChatRequest,
  now: Date
): RankingRequest[] {
  return deterministicRankingMarkets(request).map((market) => [
    market,
    isoToday(now),
  ]);
}

export function salvageEvidencePlan(
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

export const ContextualRecoverySchema = z.object({
  disposition: z.enum([
    "research",
    "social",
    "acknowledgement",
    "ambiguous",
    "out_of_scope",
  ]),
  prices: PricePairsSchema.optional().default([]),
  news: z.array(NewsQuerySchema).max(3).optional().default([]),
  rankings: z.array(RankingTupleSchema).max(2).optional().default([]),
});

import { z, ZodError } from "zod";
import {
  getMarketRankingRange,
  RANKING_RESULT_LIMIT,
} from "@/lib/market-data/market-rankings";
import { llmErrorSummary } from "@/lib/llm";
import { logStockSage } from "@/lib/telemetry";
import { resolveTemporalContext, type MarketCalendar } from "../temporal";
import type { ChatRequest } from "../types";
import type {
  RankingCapabilityOutcome,
  RankingMarket,
  RankingRequest,
  RefinedRankingRequest,
} from "./contracts";
import {
  deterministicRankingMarket,
  explicitRankingMarketMention,
  semanticContext,
} from "./context";
import {
  isRecoverableLlmTransportFailure,
  simpleLlmChatJSON,
  type SimpleJsonCall,
} from "./llm";
import { IsoDateSchema, summarizeZodIssues } from "./validation";

const MAX_ACCEPTED_RANKING_LIMIT = 50;

const RankingRefinementSchema = z.object({
  requests: z
    .array(
      z.object({
        market: z.enum(["US", "ASX", "UNSPECIFIED"]),
        startDate: IsoDateSchema,
        endDate: IsoDateSchema,
        sector: z.string().trim().min(1).max(80).nullable(),
        limit: z.number().int().min(1).max(MAX_ACCEPTED_RANKING_LIMIT),
      })
    )
    .max(2),
});

function clampRankingLimit(requestedLimit: number): {
  limit: number;
  requestedLimit?: number;
} {
  return requestedLimit <= RANKING_RESULT_LIMIT
    ? { limit: requestedLimit }
    : { limit: RANKING_RESULT_LIMIT, requestedLimit };
}

export function rankingRequestsFromSeed(
  seed: readonly RankingRequest[]
): RefinedRankingRequest[] {
  return seed.map(([market, date]) => ({
    market: market === "UNSPECIFIED" ? "US" : market,
    startDate: date,
    endDate: date,
    sector: null,
    limit: RANKING_RESULT_LIMIT,
  }));
}

const RANKING_COUNT_PATTERNS = [
  /\b(?:top|bottom)\s+(\d{1,3})\b/gi,
  /\b(\d{1,3})\s+(?:best|worst)\b/gi,
];

function detectRequestedRankingLimit(message: string): number | undefined {
  let detected: number | undefined;
  for (const pattern of RANKING_COUNT_PATTERNS) {
    for (const match of message.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 1) {
        detected = detected === undefined ? value : Math.max(detected, value);
      }
    }
  }
  return detected;
}

function splitRankingClauses(message: string): string[] {
  return message
    .split(/,|\band\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function detectPerMarketRequestedLimits(
  message: string
): Partial<Record<"US" | "ASX", number>> {
  const perMarket: Partial<Record<"US" | "ASX", number>> = {};
  for (const clause of splitRankingClauses(message)) {
    const market = explicitRankingMarketMention(clause);
    const count = detectRequestedRankingLimit(clause);
    if (!market || count === undefined || perMarket[market] !== undefined) {
      continue;
    }
    perMarket[market] = count;
  }
  return perMarket;
}

const SECTOR_PATTERN =
  /\b(tech(?:nology)?|health\s?care|energy|financials?|industrials?|utilities|materials|real estate|consumer (?:staples|discretionary)|telecom(?:munications)?)\s+(?:sector|stocks|shares|companies)\b/i;

function detectRankingSector(message: string): string | null {
  const match = SECTOR_PATTERN.exec(message);
  return match ? match[1].trim() : null;
}

function marketCalendar(market: RankingMarket): MarketCalendar {
  return market === "ASX" ? "AU" : "US";
}

function deterministicRankingDateRange(
  request: ChatRequest,
  market: RankingMarket,
  seedDate: string,
  now: Date
): { startDate: string; endDate: string } {
  const temporal = resolveTemporalContext({
    message: request.message,
    calendar: marketCalendar(market),
    now,
  });
  if (temporal.status === "resolved") {
    const interval = temporal.intervals[temporal.intervals.length - 1];
    return { startDate: interval.startSession, endDate: interval.endSession };
  }
  return { startDate: seedDate, endDate: seedDate };
}

function deterministicRankingRequests(
  request: ChatRequest,
  seed: readonly RankingRequest[],
  now: Date
): RefinedRankingRequest[] {
  const sector = detectRankingSector(request.message);
  const explicitUserLimit =
    seed.length === 1
      ? detectRequestedRankingLimit(request.message)
      : undefined;
  const perMarketLimits =
    seed.length > 1 ? detectPerMarketRequestedLimits(request.message) : {};
  return seed.map(([seedMarket, seedDate]) => {
    const market =
      seedMarket === "UNSPECIFIED"
        ? deterministicRankingMarket(request)
        : seedMarket;
    const clamped = clampRankingLimit(
      explicitUserLimit ??
        (market === "US" || market === "ASX"
          ? perMarketLimits[market]
          : undefined) ??
        RANKING_RESULT_LIMIT
    );
    const { startDate, endDate } = deterministicRankingDateRange(
      request,
      market,
      seedDate,
      now
    );
    return {
      market,
      startDate,
      endDate,
      sector,
      limit: clamped.limit,
      ...(clamped.requestedLimit
        ? { requestedLimit: clamped.requestedLimit }
        : {}),
    };
  });
}

export async function refineRankingRequests(
  request: ChatRequest,
  seed: readonly RankingRequest[],
  now = new Date(),
  jsonCall: SimpleJsonCall = simpleLlmChatJSON
): Promise<RefinedRankingRequest[]> {
  if (seed.length === 0) return [];

  let raw: unknown;
  try {
    raw = await jsonCall({
      maxTokens: 600,
      temperature: 0,
      reasoningEffort: "low",
      timeoutMs: 12_000,
      system: `You refine only market-wide ranking requests for a financial research assistant.
Return only {"requests":[{"market":"US"|"ASX"|"UNSPECIFIED","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","sector":string|null,"limit":number}]}.

Use the conversation, current message, today's date, and seed ranking requests to recover the user's exact ranking scope.
- Preserve every explicitly requested market. "Both" after US/ASX means one request for US and one for ASX.
- The default ranking market is US. Use US when no market was stated. Use ASX only when the user explicitly requested ASX.
- For a single day or "today", startDate and endDate are the same.
- For a period such as "last 6 months" or "year to date", calculate the calendar start and end dates. Never collapse a period into one day.
- sector is null for the whole market. Preserve an explicit sector or industry in concise words.
- limit is the requested top/bottom count, defaulting to 5 when the user did not ask for a specific count.
- Do not add a sector, market, date range, or request the user did not ask for.
- Do not answer the question and do not add fields.`,
      user: JSON.stringify({
        ...JSON.parse(semanticContext(request, now)),
        seedRankings: seed,
      }),
    });
  } catch (error) {
    if (!isRecoverableLlmTransportFailure(error)) throw error;
    logStockSage({
      event: "simple_ranking_refinement_recovered",
      reasonCode: "provider_failure",
      detail: JSON.stringify(llmErrorSummary(error)),
    });
    return deterministicRankingRequests(request, seed, now);
  }

  let parsed: z.infer<typeof RankingRefinementSchema>;
  try {
    parsed = RankingRefinementSchema.parse(raw);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    logStockSage({
      event: "simple_ranking_refinement_recovered",
      reasonCode: "malformed_refinement",
      detail: JSON.stringify(summarizeZodIssues(error)),
    });
    return deterministicRankingRequests(request, seed, now);
  }

  if (parsed.requests.length === 0) {
    return deterministicRankingRequests(request, seed, now);
  }

  const singleRequestLimit =
    parsed.requests.length === 1
      ? detectRequestedRankingLimit(request.message)
      : undefined;
  const perMarketLimits =
    parsed.requests.length > 1
      ? detectPerMarketRequestedLimits(request.message)
      : undefined;
  return parsed.requests.map((rankingRequest) => {
    const market =
      rankingRequest.market === "UNSPECIFIED"
        ? deterministicRankingMarket(request)
        : rankingRequest.market;
    const perMarketLimit =
      market === "US" || market === "ASX" ? perMarketLimits?.[market] : undefined;
    const sourceLimit = singleRequestLimit ?? perMarketLimit ?? rankingRequest.limit;
    const clamped = clampRankingLimit(sourceLimit);
    return {
      market,
      startDate: rankingRequest.startDate,
      endDate: rankingRequest.endDate,
      sector: rankingRequest.sector,
      limit: clamped.limit,
      ...(clamped.requestedLimit
        ? { requestedLimit: clamped.requestedLimit }
        : {}),
    };
  });
}

function unsupportedRankingOutcome(
  request: RefinedRankingRequest
): RankingCapabilityOutcome | undefined {
  if (request.startDate > request.endDate) {
    return {
      request,
      status: "needs_clarification",
      reason: "invalid_date_range",
      alternatives: ["whole_us_market"],
    };
  }
  if (request.market === "UNSPECIFIED") {
    return {
      request,
      status: "needs_clarification",
      reason: "market_required",
      alternatives: ["whole_us_market"],
    };
  }
  if (request.market === "ASX") {
    return {
      request,
      status: "unsupported",
      reason: "asx_market_wide_unsupported",
      alternatives: [
        "summarize_asx_market",
        "compare_named_securities",
        "whole_us_market",
      ],
    };
  }
  if (request.sector) {
    return {
      request,
      status: "unsupported",
      reason: "sector_classification_unavailable",
      alternatives: ["whole_us_market", "compare_named_securities"],
    };
  }
  return undefined;
}

export async function retrieveRankingCapabilityOutcomes(
  requests: readonly RefinedRankingRequest[],
  now = new Date()
): Promise<RankingCapabilityOutcome[]> {
  const outcomes: Array<RankingCapabilityOutcome | undefined> = requests.map(
    unsupportedRankingOutcome
  );
  const supported = requests
    .map((request, index) => ({ request, index }))
    .filter(({ index }) => !outcomes[index]);
  const packets =
    supported.length === 0
      ? []
      : await Promise.all(
          supported.map(({ request }) =>
            getMarketRankingRange(
              {
                market: request.market as "US",
                startDate: request.startDate,
                endDate: request.endDate,
                limit: request.limit,
              },
              now
            )
          )
        );
  for (const [packetIndex, { request, index }] of supported.entries()) {
    const packet = packets[packetIndex];
    outcomes[index] = packet
      ? {
          request,
          status: packet.status === "available" ? "available" : "unavailable",
          ...(packet.reason ? { reason: packet.reason } : {}),
          alternatives: ["compare_named_securities"],
          evidence: packet,
        }
      : {
          request,
          status: "unavailable",
          reason: "no_data",
          alternatives: ["compare_named_securities"],
        };
  }
  return outcomes.filter(
    (outcome): outcome is RankingCapabilityOutcome => Boolean(outcome)
  );
}

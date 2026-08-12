import { getMarketRankingRange } from "@/lib/market-data/market-rankings";
import { z } from "zod";
import type { ChatRequest } from "../types";
import type {
  RankingCapabilityOutcome,
  RankingRequest,
  RefinedRankingRequest,
} from "./contracts";
import { semanticContext } from "./context";
import { simpleLlmChatJSON } from "./llm";
import { IsoDateSchema } from "./validation";

const RankingRefinementSchema = z.object({
  requests: z
    .array(
      z.object({
        market: z.enum(["US", "ASX", "UNSPECIFIED"]),
        startDate: IsoDateSchema,
        endDate: IsoDateSchema,
        sector: z.string().trim().min(1).max(80).nullable(),
        limit: z.number().int().min(1).max(5),
      })
    )
    .max(2),
});

export function rankingRequestsFromSeed(
  seed: readonly RankingRequest[]
): RefinedRankingRequest[] {
  return seed.map(([market, date]) => ({
    market: market === "UNSPECIFIED" ? "US" : market,
    startDate: date,
    endDate: date,
    sector: null,
    limit: 5,
  }));
}

export async function refineRankingRequests(
  request: ChatRequest,
  seed: readonly RankingRequest[],
  now = new Date()
): Promise<RefinedRankingRequest[]> {
  if (seed.length === 0) return [];
  const raw = await simpleLlmChatJSON<unknown>({
    maxTokens: 600,
    temperature: 0,
    reasoningEffort: "low",
    timeoutMs: 12_000,
    system: `You refine only market-wide ranking requests for a financial research assistant.
Return only {"requests":[{"market":"US"|"ASX"|"UNSPECIFIED","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","sector":string|null,"limit":1-5}]}.

Use the conversation, current message, today's date, and seed ranking requests to recover the user's exact ranking scope.
- Preserve every explicitly requested market. "Both" after US/ASX means one request for US and one for ASX.
- The default ranking market is US. Use US when no market was stated. Use ASX only when the user explicitly requested ASX.
- For a single day or "today", startDate and endDate are the same.
- For a period such as "last 6 months", calculate the calendar start and end dates. Never collapse a period into one day.
- sector is null for the whole market. Preserve an explicit sector or industry in concise words.
- limit is the requested top/bottom count, defaulting to 5 and capped at 5.
- Do not add a sector, market, date range, or request the user did not ask for.
- Do not answer the question and do not add fields.`,
    user: JSON.stringify({
      ...JSON.parse(semanticContext(request, now)),
      seedRankings: seed,
    }),
  });
  const parsed = RankingRefinementSchema.parse(raw);
  const requests =
    parsed.requests.length > 0
      ? parsed.requests
      : rankingRequestsFromSeed(seed);
  return requests.map((rankingRequest) => ({
    ...rankingRequest,
    market:
      rankingRequest.market === "UNSPECIFIED"
        ? "US"
        : rankingRequest.market,
  }));
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

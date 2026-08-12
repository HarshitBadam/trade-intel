import "server-only";

import { unstable_cache } from "next/cache";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import { latestCompletedSession } from "@/lib/market-calendar";
import { logStockSage } from "@/lib/telemetry";
import {
  computeCloseToCloseMovers,
  limitRankingPacket,
  requestedSessionAtOrBefore,
  resolveUsRankingSession,
  summarizeMarketMovers,
  unavailableRankingPacket,
} from "./market-ranking-core";
import {
  fetchCompletedUsPeriodRanking,
  fetchCompletedUsRanking,
} from "./market-ranking-polygon-history";
import {
  fetchLiveUsRanking,
  fetchRecentCompletedUsRanking,
} from "./market-ranking-retrieval";
import type {
  MarketRankingPacket,
  MarketRankingRangeRequest,
  RankingMarket,
} from "./market-ranking-types";

export type {
  MarketRankingPacket,
  MarketRankingRangeRequest,
  RankedMover,
  RankingFailureReason,
  RankingMarket,
  RankingMetric,
  RankingMode,
  RankingStatus,
} from "./market-ranking-types";
export {
  computeCloseToCloseMovers,
  resolveUsRankingSession,
  summarizeMarketMovers,
};

const getCompletedUsRankingCachedBase = unstable_cache(
  (_namespace: string, session: string) => fetchCompletedUsRanking(session),
  ["us-market-ranking-completed-v2"],
  { revalidate: 86_400, tags: ["market-rankings"] }
);

function getCompletedUsRankingCached(
  session: string
): Promise<MarketRankingPacket> {
  return getCompletedUsRankingCachedBase("historical-completed-v2", session);
}

const getCompletedUsPeriodRankingCachedBase = unstable_cache(
  (_namespace: string, startSession: string, endSession: string) =>
    fetchCompletedUsPeriodRanking(startSession, endSession),
  ["us-market-ranking-completed-period-v1"],
  { revalidate: 86_400, tags: ["market-rankings"] }
);

function getCompletedUsPeriodRankingCached(
  startSession: string,
  endSession: string
): Promise<MarketRankingPacket> {
  return getCompletedUsPeriodRankingCachedBase(
    "historical-completed-period-v1",
    startSession,
    endSession
  );
}

const getLiveUsRankingCachedBase = unstable_cache(
  (_namespace: string, session: string) => fetchLiveUsRanking(session),
  ["us-market-ranking-live-v2"],
  { revalidate: 300, tags: ["market-rankings"] }
);

function getLiveUsRankingCached(
  session: string
): Promise<MarketRankingPacket> {
  return getLiveUsRankingCachedBase("live-session-v2", session);
}

const getRecentCompletedUsRankingCachedBase = unstable_cache(
  (_namespace: string, session: string) =>
    fetchRecentCompletedUsRanking(session),
  ["us-market-ranking-recent-completed-v3"],
  { revalidate: 86_400, tags: ["market-rankings"] }
);

function getRecentCompletedUsRankingCached(
  session: string
): Promise<MarketRankingPacket> {
  return getRecentCompletedUsRankingCachedBase(
    "recent-completed-v3",
    session
  );
}

export async function getMarketRanking(
  market: RankingMarket,
  requestedDate: string,
  now = new Date(),
  options: { cache?: boolean } = {}
): Promise<MarketRankingPacket> {
  if (market === "ASX") {
    const packet = unavailableRankingPacket({
      market,
      requestedDate,
      session: requestedDate,
      mode: "completed_session",
      metric: "adjusted_close_to_close",
      reason: "asx_market_wide_unsupported",
    });
    logStockSage({
      event: "market_ranking_retrieval",
      route: "comparison",
      reasonCode: packet.reason,
      durationMs: 0,
      providerCalls: {},
      yields: { gainers: 0, losers: 0 },
      detail: JSON.stringify({
        provider: "none",
        session: requestedDate,
        mode: packet.mode,
        status: packet.status,
      }),
    });
    return packet;
  }

  const resolution = resolveUsRankingSession(requestedDate, now);
  const session = resolution.session;
  const latestCompleted = latestCompletedSession("US", now);
  const getLive =
    options.cache === false ? fetchLiveUsRanking : getLiveUsRankingCached;
  const getHistoricalCompleted =
    options.cache === false
      ? fetchCompletedUsRanking
      : getCompletedUsRankingCached;
  const getRecentCompleted =
    options.cache === false
      ? fetchRecentCompletedUsRanking
      : getRecentCompletedUsRankingCached;
  if (resolution.mode === "live_session") {
    const live = await getLive(session);
    if (live.status === "available") {
      return { ...live, requestedDate };
    }
    if (hasPolygon) {
      try {
        const completed = await getRecentCompleted(latestCompleted);
        if (completed.status === "available") {
          return { ...completed, requestedDate };
        }
      } catch {
        // Keep the more specific live-session failure.
      }
    }
    return { ...live, requestedDate };
  }
  if (!hasPolygon && !(hasAlpaca && session === latestCompleted)) {
    return unavailableRankingPacket({
      market,
      requestedDate,
      session,
      mode: "completed_session",
      metric: "adjusted_close_to_close",
      reason: "provider_not_configured",
    });
  }
  try {
    const packet =
      session === latestCompleted
        ? await getRecentCompleted(session)
        : await getHistoricalCompleted(session);
    return { ...packet, requestedDate };
  } catch {
    return unavailableRankingPacket({
      market,
      requestedDate,
      session,
      mode: "completed_session",
      metric: "adjusted_close_to_close",
      reason: "provider_error",
    });
  }
}

export async function getMarketRankingRange(
  request: MarketRankingRangeRequest,
  now = new Date(),
  options: { cache?: boolean } = {}
): Promise<MarketRankingPacket> {
  if (request.market === "ASX") {
    const packet = await getMarketRanking(
      "ASX",
      request.endDate,
      now,
      options
    );
    return {
      ...packet,
      requestedStartDate: request.startDate,
      requestedEndDate: request.endDate,
    };
  }

  const latestCompleted = latestCompletedSession("US", now);
  const requestedStart = requestedSessionAtOrBefore(request.startDate);
  const requestedEnd = requestedSessionAtOrBefore(request.endDate);
  const startSession =
    requestedStart > latestCompleted ? latestCompleted : requestedStart;
  const endSession =
    requestedEnd > latestCompleted ? latestCompleted : requestedEnd;

  if (startSession >= endSession) {
    const packet = await getMarketRanking(
      "US",
      request.endDate,
      now,
      options
    );
    return limitRankingPacket(
      {
        ...packet,
        requestedStartDate: request.startDate,
        requestedEndDate: request.endDate,
      },
      request.limit
    );
  }

  if (!hasPolygon) {
    return unavailableRankingPacket({
      market: "US",
      requestedDate: request.endDate,
      session: endSession,
      mode: "completed_period",
      metric: "adjusted_close_to_close",
      reason: "provider_not_configured",
    });
  }

  try {
    const packet =
      options.cache === false
        ? await fetchCompletedUsPeriodRanking(startSession, endSession)
        : await getCompletedUsPeriodRankingCached(startSession, endSession);
    return limitRankingPacket(
      {
        ...packet,
        requestedDate: request.endDate,
        requestedStartDate: request.startDate,
        requestedEndDate: request.endDate,
        startSession,
        endSession,
      },
      request.limit
    );
  } catch {
    return unavailableRankingPacket({
      market: "US",
      requestedDate: request.endDate,
      session: endSession,
      mode: "completed_period",
      metric: "adjusted_close_to_close",
      reason: "provider_error",
    });
  }
}

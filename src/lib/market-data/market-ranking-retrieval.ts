import { hasAlpaca, hasPolygon } from "@/lib/config";
import { logStockSage } from "@/lib/telemetry";
import {
  fetchAlpacaCompletedRanking,
  fetchAlpacaLiveRanking,
} from "./market-ranking-alpaca";
import { unavailableRankingPacket } from "./market-ranking-core";
import { fetchCompletedUsRanking } from "./market-ranking-polygon-history";
import { fetchPolygonLiveRanking } from "./market-ranking-polygon-live";
import type { MarketRankingPacket } from "./market-ranking-types";

function logAvailableRanking(
  packet: MarketRankingPacket,
  startedAt: number,
  provider: "alpaca" | "polygon",
  providerCalls: number
): void {
  logStockSage({
    event: "market_ranking_retrieval",
    route: "comparison",
    reasonCode: packet.reason ?? "available",
    durationMs: Date.now() - startedAt,
    providerCalls: { [provider]: providerCalls },
    yields: {
      gainers: packet.gainers.length,
      losers: packet.losers.length,
    },
    detail: JSON.stringify({
      provider,
      session: packet.session,
      mode: packet.mode,
      status: packet.status,
    }),
  });
}

export async function fetchLiveUsRanking(
  session: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  if (!hasAlpaca && !hasPolygon) {
    return unavailableRankingPacket({
      market: "US",
      requestedDate: session,
      session,
      mode: "live_session",
      metric: "live_vs_previous_close",
      reason: "provider_not_configured",
    });
  }
  if (hasAlpaca) {
    try {
      const packet = await fetchAlpacaLiveRanking(session);
      if (packet.status === "available") {
        logAvailableRanking(packet, startedAt, "alpaca", 1);
        return packet;
      }
    } catch (error) {
      console.error("[stocksage] Alpaca live ranking failed:", error);
    }
  }
  if (hasPolygon) {
    try {
      const packet = await fetchPolygonLiveRanking(session);
      logAvailableRanking(packet, startedAt, "polygon", 2);
      return packet;
    } catch (error) {
      console.error("[stocksage] Polygon live ranking failed:", error);
    }
  }
  return unavailableRankingPacket({
    market: "US",
    requestedDate: session,
    session,
    mode: "live_session",
    metric: "live_vs_previous_close",
    reason: "provider_error",
  });
}

export async function fetchRecentCompletedUsRanking(
  session: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  if (hasAlpaca) {
    try {
      const packet = await fetchAlpacaCompletedRanking(session);
      if (packet.status === "available") {
        logAvailableRanking(packet, startedAt, "alpaca", 1);
        return packet;
      }
    } catch (alpacaError) {
      console.error(
        "[stocksage] recent completed Alpaca ranking failed:",
        alpacaError
      );
    }
  }
  return fetchCompletedUsRanking(session);
}

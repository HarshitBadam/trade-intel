import { previousSession } from "@/lib/market-calendar";
import { logStockSage } from "@/lib/telemetry";
import { assertPolygonOk, polygonFetch } from "./polygon";
import {
  computeCloseToCloseMovers,
  MIN_GROUPED_MARKET_ROWS,
  summarizeMarketMovers,
  unavailableRankingPacket,
} from "./market-ranking-core";
import type {
  MarketRankingPacket,
  PolygonGroupedRow,
} from "./market-ranking-types";

async function fetchPolygonGroupedDaily(
  session: string
): Promise<PolygonGroupedRow[]> {
  const response = await polygonFetch(
    `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${session}?adjusted=true&include_otc=false`
  );
  assertPolygonOk(response, `market ranking grouped daily ${session}`);
  const payload = (await response.json()) as { results?: PolygonGroupedRow[] };
  return Array.isArray(payload.results) ? payload.results : [];
}

export async function fetchCompletedUsRanking(
  session: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  const prior = previousSession(session, "US");
  try {
    const [currentRows, previousRows] = await Promise.all([
      fetchPolygonGroupedDaily(session),
      fetchPolygonGroupedDaily(prior),
    ]);
    // A small grouped response is not representative of a whole-market ranking.
    const hasWholeMarketCoverage =
      currentRows.length >= MIN_GROUPED_MARKET_ROWS &&
      previousRows.length >= MIN_GROUPED_MARKET_ROWS;
    const movers = hasWholeMarketCoverage
      ? computeCloseToCloseMovers(currentRows, previousRows)
      : [];
    const compact = summarizeMarketMovers(movers);
    const packet: MarketRankingPacket =
      compact.gainers.length > 0 && compact.losers.length > 0
        ? {
            market: "US",
            requestedDate: session,
            session,
            previousSession: prior,
            mode: "completed_session",
            metric: "adjusted_close_to_close",
            status: "available",
            provider: "polygon",
            gainers: compact.gainers,
            losers: compact.losers,
            universeNote:
              "Polygon US stock aggregates excluding OTC; minimum session volume 10,000.",
          }
        : unavailableRankingPacket({
            market: "US",
            requestedDate: session,
            session,
            mode: "completed_session",
            metric: "adjusted_close_to_close",
            reason: hasWholeMarketCoverage ? "no_data" : "partial_universe",
          });
    logStockSage({
      event: "market_ranking_retrieval",
      route: "comparison",
      reasonCode: packet.reason ?? "available",
      durationMs: Date.now() - startedAt,
      providerCalls: { polygon: 2 },
      yields: {
        currentRows: currentRows.length,
        previousRows: previousRows.length,
        rankedRows: movers.length,
      },
      detail: JSON.stringify({
        provider: packet.provider ?? "polygon",
        session,
        mode: packet.mode,
        status: packet.status,
      }),
    });
    return packet;
  } catch (error) {
    logStockSage({
      event: "market_ranking_retrieval",
      route: "comparison",
      reasonCode: "provider_error",
      durationMs: Date.now() - startedAt,
      providerCalls: { polygon: 2 },
      yields: { currentRows: 0, previousRows: 0, rankedRows: 0 },
      detail: JSON.stringify({
        provider: "polygon",
        session,
        mode: "completed_session",
        status: "unavailable",
      }),
    });
    console.error("[stocksage] historical US ranking failed:", error);
    throw error;
  }
}

export async function fetchCompletedUsPeriodRanking(
  startSession: string,
  endSession: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  try {
    const [endRows, startRows] = await Promise.all([
      fetchPolygonGroupedDaily(endSession),
      fetchPolygonGroupedDaily(startSession),
    ]);
    const hasWholeMarketCoverage =
      endRows.length >= MIN_GROUPED_MARKET_ROWS &&
      startRows.length >= MIN_GROUPED_MARKET_ROWS;
    const movers = hasWholeMarketCoverage
      ? computeCloseToCloseMovers(endRows, startRows)
      : [];
    const compact = summarizeMarketMovers(movers);
    const packet: MarketRankingPacket =
      compact.gainers.length > 0 && compact.losers.length > 0
        ? {
            market: "US",
            requestedDate: endSession,
            requestedStartDate: startSession,
            requestedEndDate: endSession,
            session: endSession,
            previousSession: startSession,
            startSession,
            endSession,
            mode: "completed_period",
            metric: "adjusted_close_to_close",
            status: "available",
            provider: "polygon",
            gainers: compact.gainers,
            losers: compact.losers,
            universeNote:
              "Polygon US stock aggregates excluding OTC; minimum end-session volume 10,000.",
          }
        : unavailableRankingPacket({
            market: "US",
            requestedDate: endSession,
            session: endSession,
            mode: "completed_period",
            metric: "adjusted_close_to_close",
            reason: hasWholeMarketCoverage ? "no_data" : "partial_universe",
          });
    logStockSage({
      event: "market_ranking_retrieval",
      route: "comparison",
      reasonCode: packet.reason ?? "available",
      durationMs: Date.now() - startedAt,
      providerCalls: { polygon: 2 },
      yields: {
        startRows: startRows.length,
        endRows: endRows.length,
        rankedRows: movers.length,
      },
      detail: JSON.stringify({
        provider: packet.provider ?? "polygon",
        startSession,
        endSession,
        mode: packet.mode,
        status: packet.status,
      }),
    });
    return packet;
  } catch (error) {
    logStockSage({
      event: "market_ranking_retrieval",
      route: "comparison",
      reasonCode: "provider_error",
      durationMs: Date.now() - startedAt,
      providerCalls: { polygon: 2 },
      yields: { startRows: 0, endRows: 0, rankedRows: 0 },
      detail: JSON.stringify({
        provider: "polygon",
        startSession,
        endSession,
        mode: "completed_period",
        status: "unavailable",
      }),
    });
    console.error("[stocksage] historical US period ranking failed:", error);
    throw error;
  }
}

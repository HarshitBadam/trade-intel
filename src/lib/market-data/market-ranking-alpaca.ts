import { previousSession } from "@/lib/market-calendar";
import { getAlpacaMarketMovers } from "./alpaca";
import {
  rankingUniverseName,
  RANKING_RESULT_LIMIT,
  unavailableRankingPacket,
  usSessionFromTimestamp,
} from "./market-ranking-core";
import type {
  MarketRankingPacket,
  RankedMover,
} from "./market-ranking-types";

function liveRowsFromAlpaca(
  rows: Awaited<ReturnType<typeof getAlpacaMarketMovers>>["gainers"]
): RankedMover[] {
  return rows.flatMap((row) => {
    const ticker = row.symbol.toUpperCase();
    const previousClose = row.price - row.change;
    const name = rankingUniverseName(ticker);
    if (!name || row.price < 1 || previousClose < 1) return [];
    return [
      {
        ticker,
        name,
        close: row.price,
        previousClose,
        change: row.change,
        returnPct: row.percentChange,
      },
    ];
  });
}

export async function fetchAlpacaCompletedRanking(
  session: string
): Promise<MarketRankingPacket> {
  const movers = await getAlpacaMarketMovers(50);
  if (usSessionFromTimestamp(movers.lastUpdated) !== session) {
    return unavailableRankingPacket({
      market: "US",
      requestedDate: session,
      session,
      mode: "completed_session",
      metric: "adjusted_close_to_close",
      reason: "no_data",
    });
  }
  const gainers = liveRowsFromAlpaca(movers.gainers)
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, RANKING_RESULT_LIMIT);
  const losers = liveRowsFromAlpaca(movers.losers)
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, RANKING_RESULT_LIMIT);
  if (gainers.length === 0 || losers.length === 0) {
    return unavailableRankingPacket({
      market: "US",
      requestedDate: session,
      session,
      mode: "completed_session",
      metric: "adjusted_close_to_close",
      reason: "no_data",
    });
  }
  return {
    market: "US",
    requestedDate: session,
    session,
    previousSession: previousSession(session, "US"),
    mode: "completed_session",
    metric: "adjusted_close_to_close",
    status: "available",
    provider: "alpaca",
    asOf: movers.lastUpdated,
    gainers,
    losers,
    universeNote:
      "Alpaca tradable US exchange-listed stocks, split-adjusted from the previous close.",
  };
}

export async function fetchAlpacaLiveRanking(
  session: string
): Promise<MarketRankingPacket> {
  const movers = await getAlpacaMarketMovers(50);
  const gainers = liveRowsFromAlpaca(movers.gainers)
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, RANKING_RESULT_LIMIT);
  const losers = liveRowsFromAlpaca(movers.losers)
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, RANKING_RESULT_LIMIT);
  if (gainers.length === 0 || losers.length === 0) {
    return unavailableRankingPacket({
      market: "US",
      requestedDate: session,
      session,
      mode: "live_session",
      metric: "live_vs_previous_close",
      reason: "no_data",
    });
  }
  return {
    market: "US",
    requestedDate: session,
    session,
    previousSession: previousSession(session, "US"),
    mode: "live_session",
    metric: "live_vs_previous_close",
    status: "available",
    provider: "alpaca",
    asOf: movers.lastUpdated ?? new Date().toISOString(),
    gainers,
    losers,
    universeNote:
      "Alpaca tradable US exchange-listed stocks, ranked from previous close to the latest price.",
  };
}

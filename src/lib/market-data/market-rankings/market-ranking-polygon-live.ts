import { previousSession } from "@/lib/market-calendar";
import { assertPolygonOk, polygonFetch } from "../providers/polygon";
import {
  isoTimestamp,
  rankingUniverseName,
  RANKING_RESULT_LIMIT,
  unavailableRankingPacket,
} from "./market-ranking-core";
import type {
  MarketRankingPacket,
  PolygonSnapshotRow,
  RankedMover,
} from "./market-ranking-types";

function liveRowsFromPolygon(
  rows: readonly PolygonSnapshotRow[]
): RankedMover[] {
  return rows.flatMap((row) => {
    if (
      typeof row.ticker !== "string" ||
      typeof row.todaysChange !== "number" ||
      typeof row.todaysChangePerc !== "number" ||
      typeof row.day?.c !== "number" ||
      !Number.isFinite(row.todaysChange) ||
      !Number.isFinite(row.todaysChangePerc) ||
      !Number.isFinite(row.day.c)
    ) {
      return [];
    }
    const ticker = row.ticker.toUpperCase();
    const name = rankingUniverseName(ticker);
    const previousClose =
      typeof row.prevDay?.c === "number" && row.prevDay.c > 0
        ? row.prevDay.c
        : row.day.c - row.todaysChange;
    if (!name || row.day.c < 1 || previousClose < 1) return [];
    return [
      {
        ticker,
        name,
        close: row.day.c,
        ...(previousClose > 0 ? { previousClose } : {}),
        change: row.todaysChange,
        returnPct: row.todaysChangePerc,
        ...(typeof row.day.v === "number" && Number.isFinite(row.day.v)
          ? { volume: row.day.v }
          : {}),
      },
    ];
  });
}

async function fetchPolygonSnapshotDirection(
  direction: "gainers" | "losers"
): Promise<PolygonSnapshotRow[]> {
  const response = await polygonFetch(
    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/${direction}?include_otc=false`
  );
  assertPolygonOk(response, `market ranking snapshot ${direction}`);
  const payload = (await response.json()) as { tickers?: PolygonSnapshotRow[] };
  return Array.isArray(payload.tickers) ? payload.tickers : [];
}

export async function fetchPolygonLiveRanking(
  session: string
): Promise<MarketRankingPacket> {
  const [gainerRows, loserRows] = await Promise.all([
    fetchPolygonSnapshotDirection("gainers"),
    fetchPolygonSnapshotDirection("losers"),
  ]);
  const gainers = liveRowsFromPolygon(gainerRows)
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, RANKING_RESULT_LIMIT);
  const losers = liveRowsFromPolygon(loserRows)
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
  const asOf = [...gainerRows, ...loserRows]
    .map((row) => isoTimestamp(row.updated))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    market: "US",
    requestedDate: session,
    session,
    previousSession: previousSession(session, "US"),
    mode: "live_session",
    metric: "live_vs_previous_close",
    status: "available",
    provider: "polygon",
    ...(asOf ? { asOf } : {}),
    gainers,
    losers,
    universeNote:
      "US exchange-listed stocks excluding OTC, with provider mover liquidity filtering.",
  };
}

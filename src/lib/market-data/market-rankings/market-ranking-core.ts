import {
  currentSession,
  isTradingSession,
  latestCompletedSession,
  previousSession,
} from "@/lib/market-calendar";
import { getUniverse } from "../security-master/universe";
import type {
  MarketRankingPacket,
  PolygonGroupedRow,
  RankedMover,
  RankingFailureReason,
  RankingMarket,
  RankingMetric,
  RankingMode,
} from "./market-ranking-types";

export const RANKING_RESULT_LIMIT = 5;
export const MIN_RANKING_SESSION_VOLUME = 10_000;
export const MIN_GROUPED_MARKET_ROWS = 1_000;

const UNIVERSE = new Map(
  getUniverse().map((entry) => [entry.symbol.toUpperCase(), entry.name])
);

export function rankingUniverseName(ticker: string): string | undefined {
  return UNIVERSE.get(ticker);
}

export function requestedSessionAtOrBefore(date: string): string {
  return isTradingSession(date, "US") ? date : previousSession(date, "US");
}

function cappedRequestedSession(date: string, now: Date): string {
  const requested = requestedSessionAtOrBefore(date);
  const current = currentSession("US", now);
  return requested > current ? current : requested;
}

export function resolveUsRankingSession(
  requestedDate: string,
  now = new Date()
): { session: string; mode: RankingMode } {
  const session = cappedRequestedSession(requestedDate, now);
  const latestCompleted = latestCompletedSession("US", now);
  const current = currentSession("US", now);
  return {
    session,
    mode:
      session === current && session > latestCompleted
        ? "live_session"
        : "completed_session",
  };
}

export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds =
    value > 1e15 ? value / 1e6 : value > 1e12 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function usSessionFromTimestamp(
  value: string | undefined
): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

export function unavailableRankingPacket(args: {
  market: RankingMarket;
  requestedDate: string;
  session: string;
  mode: RankingMode;
  metric: RankingMetric;
  reason: RankingFailureReason;
}): MarketRankingPacket {
  return {
    ...args,
    status:
      args.reason === "asx_market_wide_unsupported"
        ? "unsupported"
        : "unavailable",
    gainers: [],
    losers: [],
  };
}

export function summarizeMarketMovers(rows: readonly RankedMover[]): {
  gainers: RankedMover[];
  losers: RankedMover[];
} {
  const ordered = [...rows].sort((a, b) => b.returnPct - a.returnPct);
  return {
    gainers: ordered.slice(0, RANKING_RESULT_LIMIT),
    losers: ordered.slice(-RANKING_RESULT_LIMIT).reverse(),
  };
}

export function computeCloseToCloseMovers(
  currentRows: readonly PolygonGroupedRow[],
  previousRows: readonly PolygonGroupedRow[]
): RankedMover[] {
  const previousByTicker = new Map<string, number>();
  for (const row of previousRows) {
    if (
      typeof row.T === "string" &&
      typeof row.c === "number" &&
      Number.isFinite(row.c) &&
      row.c > 0
    ) {
      previousByTicker.set(row.T.toUpperCase(), row.c);
    }
  }
  return currentRows.flatMap((row) => {
    if (
      typeof row.T !== "string" ||
      typeof row.c !== "number" ||
      !Number.isFinite(row.c) ||
      row.c <= 0
    ) {
      return [];
    }
    const ticker = row.T.toUpperCase();
    const name = rankingUniverseName(ticker);
    const previousClose = previousByTicker.get(ticker);
    const volume =
      typeof row.v === "number" && Number.isFinite(row.v) ? row.v : undefined;
    if (
      !name ||
      row.c < 1 ||
      previousClose === undefined ||
      previousClose < 1 ||
      (volume ?? 0) < MIN_RANKING_SESSION_VOLUME
    ) {
      return [];
    }
    const change = row.c - previousClose;
    return [
      {
        ticker,
        ...(name ? { name } : {}),
        close: row.c,
        previousClose,
        change,
        returnPct: (change / previousClose) * 100,
        ...(volume !== undefined ? { volume } : {}),
      },
    ];
  });
}

export function limitRankingPacket(
  packet: MarketRankingPacket,
  requestedLimit: number | undefined
): MarketRankingPacket {
  const limit = Math.max(
    1,
    Math.min(
      RANKING_RESULT_LIMIT,
      Math.trunc(requestedLimit ?? RANKING_RESULT_LIMIT)
    )
  );
  return {
    ...packet,
    gainers: packet.gainers.slice(0, limit),
    losers: packet.losers.slice(0, limit),
  };
}

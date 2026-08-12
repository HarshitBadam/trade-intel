import "server-only";

import { unstable_cache } from "next/cache";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import {
  currentSession,
  isTradingSession,
  latestCompletedSession,
  previousSession,
} from "@/lib/stocksage/temporal";
import { logStockSage } from "@/lib/stocksage/telemetry";
import { getAlpacaMarketMovers } from "./alpaca";
import { assertPolygonOk, polygonFetch } from "./polygon";
import { getUniverse } from "./universe";

export type RankingMarket = "US" | "ASX";
export type RankingMode =
  | "live_session"
  | "completed_session"
  | "completed_period";
export type RankingMetric =
  | "live_vs_previous_close"
  | "adjusted_close_to_close";
export type RankingStatus = "available" | "unsupported" | "unavailable";
export type RankingFailureReason =
  | "asx_market_wide_unsupported"
  | "provider_not_configured"
  | "provider_error"
  | "no_data"
  | "partial_universe";

export type RankedMover = {
  ticker: string;
  name?: string;
  close: number;
  previousClose?: number;
  change: number;
  returnPct: number;
  volume?: number;
};

export type MarketRankingPacket = {
  market: RankingMarket;
  requestedDate: string;
  requestedStartDate?: string;
  requestedEndDate?: string;
  session: string;
  previousSession?: string;
  startSession?: string;
  endSession?: string;
  mode: RankingMode;
  metric: RankingMetric;
  status: RankingStatus;
  reason?: RankingFailureReason;
  provider?: "alpaca" | "polygon";
  asOf?: string;
  gainers: RankedMover[];
  losers: RankedMover[];
  universeNote?: string;
};

export type MarketRankingRangeRequest = {
  market: RankingMarket;
  startDate: string;
  endDate: string;
  limit?: number;
};

type PolygonGroupedRow = {
  T?: unknown;
  c?: unknown;
  v?: unknown;
};

type PolygonSnapshotRow = {
  ticker?: unknown;
  todaysChange?: unknown;
  todaysChangePerc?: unknown;
  updated?: unknown;
  day?: { c?: unknown; v?: unknown };
  prevDay?: { c?: unknown };
};

const RESULT_LIMIT = 5;
const MIN_SESSION_VOLUME = 10_000;
const MIN_GROUPED_MARKET_ROWS = 1_000;
const UNIVERSE = new Map(
  getUniverse().map((entry) => [entry.symbol.toUpperCase(), entry.name])
);

function requestedSessionAtOrBefore(date: string): string {
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

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds =
    value > 1e15 ? value / 1e6 : value > 1e12 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function usSessionFromTimestamp(value: string | undefined): string | undefined {
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

function unavailablePacket(args: {
  market: RankingMarket;
  requestedDate: string;
  session: string;
  mode: RankingMode;
  metric: RankingMetric;
  reason: RankingFailureReason;
}): MarketRankingPacket {
  return {
    ...args,
    status: args.reason === "asx_market_wide_unsupported"
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
    gainers: ordered.slice(0, RESULT_LIMIT),
    losers: ordered.slice(-RESULT_LIMIT).reverse(),
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
    const name = UNIVERSE.get(ticker);
    const previousClose = previousByTicker.get(ticker);
    const volume =
      typeof row.v === "number" && Number.isFinite(row.v) ? row.v : undefined;
    if (
      !name ||
      row.c < 1 ||
      previousClose === undefined ||
      previousClose < 1 ||
      (volume ?? 0) < MIN_SESSION_VOLUME
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

async function fetchCompletedUsRanking(
  session: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  const prior = previousSession(session, "US");
  try {
    const [currentRows, previousRows] = await Promise.all([
      fetchPolygonGroupedDaily(session),
      fetchPolygonGroupedDaily(prior),
    ]);
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
        : unavailablePacket({
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

async function fetchCompletedUsPeriodRanking(
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
        : unavailablePacket({
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

function liveRowsFromAlpaca(
  rows: Awaited<ReturnType<typeof getAlpacaMarketMovers>>["gainers"]
): RankedMover[] {
  return rows.flatMap((row) => {
    const ticker = row.symbol.toUpperCase();
    const previousClose = row.price - row.change;
    const name = UNIVERSE.get(ticker);
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

async function fetchAlpacaCompletedRanking(
  session: string
): Promise<MarketRankingPacket> {
  const movers = await getAlpacaMarketMovers(50);
  if (usSessionFromTimestamp(movers.lastUpdated) !== session) {
    return unavailablePacket({
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
    .slice(0, RESULT_LIMIT);
  const losers = liveRowsFromAlpaca(movers.losers)
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, RESULT_LIMIT);
  if (gainers.length === 0 || losers.length === 0) {
    return unavailablePacket({
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

async function fetchAlpacaLiveRanking(
  session: string
): Promise<MarketRankingPacket> {
  const movers = await getAlpacaMarketMovers(50);
  const gainers = liveRowsFromAlpaca(movers.gainers)
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, RESULT_LIMIT);
  const losers = liveRowsFromAlpaca(movers.losers)
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, RESULT_LIMIT);
  if (gainers.length === 0 || losers.length === 0) {
    return unavailablePacket({
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

function liveRowsFromPolygon(rows: readonly PolygonSnapshotRow[]): RankedMover[] {
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
    const name = UNIVERSE.get(ticker);
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

async function fetchPolygonLiveRanking(
  session: string
): Promise<MarketRankingPacket> {
  const [gainerRows, loserRows] = await Promise.all([
    fetchPolygonSnapshotDirection("gainers"),
    fetchPolygonSnapshotDirection("losers"),
  ]);
  const gainers = liveRowsFromPolygon(gainerRows)
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, RESULT_LIMIT);
  const losers = liveRowsFromPolygon(loserRows)
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, RESULT_LIMIT);
  if (gainers.length === 0 || losers.length === 0) {
    return unavailablePacket({
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

async function fetchLiveUsRanking(
  session: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  if (!hasAlpaca && !hasPolygon) {
    return unavailablePacket({
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
        logStockSage({
          event: "market_ranking_retrieval",
          route: "comparison",
          reasonCode: "available",
          durationMs: Date.now() - startedAt,
          providerCalls: { alpaca: 1 },
          yields: {
            gainers: packet.gainers.length,
            losers: packet.losers.length,
          },
          detail: JSON.stringify({
            provider: "alpaca",
            session,
            mode: packet.mode,
            status: packet.status,
          }),
        });
        return packet;
      }
    } catch (error) {
      console.error("[stocksage] Alpaca live ranking failed:", error);
    }
  }
  if (hasPolygon) {
    try {
      const packet = await fetchPolygonLiveRanking(session);
      logStockSage({
        event: "market_ranking_retrieval",
        route: "comparison",
        reasonCode: packet.reason ?? "available",
        durationMs: Date.now() - startedAt,
        providerCalls: { polygon: 2 },
        yields: {
          gainers: packet.gainers.length,
          losers: packet.losers.length,
        },
        detail: JSON.stringify({
          provider: "polygon",
          session,
          mode: packet.mode,
          status: packet.status,
        }),
      });
      return packet;
    } catch (error) {
      console.error("[stocksage] Polygon live ranking failed:", error);
    }
  }
  return unavailablePacket({
    market: "US",
    requestedDate: session,
    session,
    mode: "live_session",
    metric: "live_vs_previous_close",
    reason: "provider_error",
  });
}

const getLiveUsRankingCachedBase = unstable_cache(
  (_namespace: string, session: string) => fetchLiveUsRanking(session),
  ["us-market-ranking-live-v2"],
  { revalidate: 300, tags: ["market-rankings"] }
);

function getLiveUsRankingCached(session: string): Promise<MarketRankingPacket> {
  return getLiveUsRankingCachedBase("live-session-v2", session);
}

async function fetchRecentCompletedUsRanking(
  session: string
): Promise<MarketRankingPacket> {
  const startedAt = Date.now();
  if (hasAlpaca) {
    try {
      const packet = await fetchAlpacaCompletedRanking(session);
      if (packet.status === "available") {
        logStockSage({
          event: "market_ranking_retrieval",
          route: "comparison",
          reasonCode: "available",
          durationMs: Date.now() - startedAt,
          providerCalls: { alpaca: 1 },
          yields: {
            gainers: packet.gainers.length,
            losers: packet.losers.length,
          },
          detail: JSON.stringify({
            provider: "alpaca",
            session,
            mode: packet.mode,
            status: packet.status,
          }),
        });
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
    const packet = unavailablePacket({
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
  const isLiveSession = resolution.mode === "live_session";
  if (isLiveSession) {
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
        // Preserve the more specific live failure below.
      }
    }
    return { ...live, requestedDate };
  }
  if (!hasPolygon && !(hasAlpaca && session === latestCompleted)) {
    return unavailablePacket({
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
    return unavailablePacket({
      market,
      requestedDate,
      session,
      mode: "completed_session",
      metric: "adjusted_close_to_close",
      reason: "provider_error",
    });
  }
}

function limitRankingPacket(
  packet: MarketRankingPacket,
  requestedLimit: number | undefined
): MarketRankingPacket {
  const limit = Math.max(
    1,
    Math.min(RESULT_LIMIT, Math.trunc(requestedLimit ?? RESULT_LIMIT))
  );
  return {
    ...packet,
    gainers: packet.gainers.slice(0, limit),
    losers: packet.losers.slice(0, limit),
  };
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
    return unavailablePacket({
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
    return unavailablePacket({
      market: "US",
      requestedDate: request.endDate,
      session: endSession,
      mode: "completed_period",
      metric: "adjusted_close_to_close",
      reason: "provider_error",
    });
  }
}

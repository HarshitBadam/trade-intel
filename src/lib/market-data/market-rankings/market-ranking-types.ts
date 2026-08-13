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

export type PolygonGroupedRow = {
  T?: unknown;
  c?: unknown;
  v?: unknown;
};

export type PolygonSnapshotRow = {
  ticker?: unknown;
  todaysChange?: unknown;
  todaysChangePerc?: unknown;
  updated?: unknown;
  day?: { c?: unknown; v?: unknown };
  prevDay?: { c?: unknown };
};

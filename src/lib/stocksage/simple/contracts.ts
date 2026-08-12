import type { MarketRankingPacket } from "@/lib/market-data/market-rankings";
import type { RangeBarSeries } from "@/lib/market-data/range-bars";
import type { createEvidenceSources, EvidenceInput } from "../citations";
import type { TavilySearchStatus } from "../tavily";
import type { MarketCalendar } from "../temporal";
import type {
  ChatRequest,
  FinanceEntity,
} from "../types";

export type SubjectDatePair = readonly [subject: string, date: string];
export type RankingMarket = "US" | "ASX" | "UNSPECIFIED";
export type RankingRequest = readonly [market: RankingMarket, date: string];

export type SimpleEvidencePlan = {
  prices: SubjectDatePair[];
  news: string[];
  rankings: RankingRequest[];
};

export type RefinedRankingRequest = {
  market: RankingMarket;
  startDate: string;
  endDate: string;
  sector: string | null;
  limit: number;
};

export type RankingCapabilityOutcome = {
  request: RefinedRankingRequest;
  status: "available" | "unsupported" | "needs_clarification" | "unavailable";
  reason?:
    | "market_required"
    | "invalid_date_range"
    | "asx_market_wide_unsupported"
    | "sector_classification_unavailable"
    | "provider_not_configured"
    | "provider_error"
    | "no_data"
    | "partial_universe";
  alternatives: Array<
    | "whole_us_market"
    | "compare_named_securities"
    | "summarize_asx_market"
  >;
  evidence?: MarketRankingPacket;
};

export type FocusedNewsOutcome = {
  query: string;
  status: TavilySearchStatus;
  reason?: string;
  evidenceCount: number;
};

export type FocusedNewsBundle = {
  evidence: EvidenceInput[];
  outcomes: FocusedNewsOutcome[];
};

export type ResolvedPair = {
  subject: string;
  date: string;
  entity: FinanceEntity;
};

export type MarketPacket = {
  entityId: string;
  name: string;
  ticker: string;
  calendar: MarketCalendar;
  status: RangeBarSeries["status"];
  reason?: RangeBarSeries["reason"];
  provider?: string;
  instrumentSymbol: string;
  currency?: string;
  requestedPoints: Array<{
    requestedDate: string;
    session?: string;
    close?: number;
  }>;
  firstClose?: number;
  lastClose?: number;
  returnPct?: number;
  returnKind: "single_session" | "period";
  listingDate?: string;
  monthlyCloses?: Array<{
    month: string;
    session: string;
    close: number;
  }>;
  quarterlyPerformance?: Array<{
    quarter: string;
    startSession: string;
    endSession: string;
    startClose: number;
    endClose: number;
    returnPct: number;
    status: "complete" | "to_date" | "partial";
  }>;
  pointToPointReturns?: Array<{
    fromRequestedDate: string;
    toRequestedDate: string;
    returnPct: number;
  }>;
};

export type SimpleComposeArgs = {
  request: ChatRequest;
  pairs: readonly SubjectDatePair[];
  entities: readonly FinanceEntity[];
  market: readonly MarketPacket[];
  sources: ReturnType<typeof createEvidenceSources>;
  focusedNews: FocusedNewsBundle;
  rankings: readonly MarketRankingPacket[];
  rankingOutcomes: readonly RankingCapabilityOutcome[];
  now?: Date;
};

export type SimpleCompositionPayload = {
  today: string;
  conversation: string;
  question: string;
  extractedPrices: readonly SubjectDatePair[];
  resolvedEntities: readonly FinanceEntity[];
  marketEvidence: readonly MarketPacket[];
  focusedNewsRequests: readonly FocusedNewsOutcome[];
  rankingEvidence: readonly MarketRankingPacket[];
  rankingOutcomes: ReadonlyArray<
    Omit<RankingCapabilityOutcome, "evidence">
  >;
  newsEvidence: string;
};

export type SimpleRuntimeDependencies = {
  now?: Date;
  extractPlan?: (request: ChatRequest) => Promise<SimpleEvidencePlan>;
  retrieveMarket?: (
    pairs: readonly ResolvedPair[]
  ) => Promise<MarketPacket[]>;
  retrieveGeneralNews?: (
    request: ChatRequest,
    entities: readonly FinanceEntity[],
    dates: readonly string[]
  ) => Promise<EvidenceInput[]>;
  retrieveFocusedNews?: (
    queries: readonly string[],
    entities: readonly FinanceEntity[]
  ) => Promise<FocusedNewsBundle>;
  refineRankings?: (
    request: ChatRequest,
    seed: readonly RankingRequest[],
    now?: Date
  ) => Promise<RefinedRankingRequest[]>;
  retrieveRankingOutcomes?: (
    requests: readonly RefinedRankingRequest[],
    now?: Date
  ) => Promise<RankingCapabilityOutcome[]>;
  repairListingPrices?: (
    request: ChatRequest,
    prices: readonly SubjectDatePair[],
    listingContext: readonly {
      name: string;
      ticker: string;
      listingDate: string;
    }[],
    now?: Date
  ) => Promise<SubjectDatePair[]>;
  composeAnswer?: (args: SimpleComposeArgs) => Promise<string>;
  onExtractionComplete?: (plan: SimpleEvidencePlan) => void;
  onRankingRefinement?: (requests: readonly RefinedRankingRequest[]) => void;
  onCompositionPayload?: (payload: SimpleCompositionPayload) => void;
};

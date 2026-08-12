import "server-only";

export {
  buildSimpleCompositionPayload,
  polishSimpleAnswerStyle,
} from "./simple/composition";
export type {
  FocusedNewsBundle,
  FocusedNewsOutcome,
  MarketPacket,
  RankingCapabilityOutcome,
  RankingMarket,
  RankingRequest,
  RefinedRankingRequest,
  ResolvedPair,
  SimpleComposeArgs,
  SimpleCompositionPayload,
  SimpleEvidencePlan,
  SimpleRuntimeDependencies,
  SubjectDatePair,
} from "./simple/contracts";
export { shouldFallbackSimpleLlm } from "./simple/llm";
export {
  monthlyClosesFromBars,
  quarterlyPerformanceFromBars,
} from "./simple/market";
export { retrieveFocusedNews } from "./simple/news";
export { runSimpleChatAdapter } from "./simple/orchestrator";
export { refineRankingRequests } from "./simple/ranking";
export {
  hasSimpleEvidenceRequest,
  normalizeSimpleEvidencePlan,
} from "./simple/validation";

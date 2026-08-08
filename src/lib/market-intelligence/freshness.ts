import type { MarketIntelligenceState } from "./types";

export const NEWS_FRESH_FOR_MS = 60 * 60 * 1000;
export const NEWS_DEGRADED_AFTER_MS = 48 * 60 * 60 * 1000;

export type FreshnessInput = {
  hasUsableContent: boolean;
  concludedAt?: string | null;
  newsCheckedAt?: string | null;
  analysisFingerprint?: string | null;
  expectedAnalysisFingerprint?: string | null;
  lastErrorCode?: string | null;
  now?: number | Date;
};

function fingerprintsMatch(input: FreshnessInput): boolean {
  if (input.expectedAnalysisFingerprint == null) return true;
  return input.analysisFingerprint === input.expectedAnalysisFingerprint;
}

export function classifyMarketIntelligence(
  input: FreshnessInput
): MarketIntelligenceState {
  if (!input.hasUsableContent) return "missing";

  const concludedAt = Date.parse(input.concludedAt ?? "");
  const checkedAt = Date.parse(input.newsCheckedAt ?? "");
  const now =
    input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now();
  const conclusionAge = now - concludedAt;
  const providerAge = now - checkedAt;

  if (!Number.isFinite(concludedAt) || !Number.isFinite(checkedAt)) return "stale";
  if (conclusionAge < 0 || providerAge < 0) return "stale";
  if (
    conclusionAge >= NEWS_DEGRADED_AFTER_MS ||
    providerAge >= NEWS_DEGRADED_AFTER_MS
  ) {
    return "hard_expired";
  }
  if (input.lastErrorCode) return "degraded";
  if (
    conclusionAge <= NEWS_FRESH_FOR_MS &&
    providerAge <= NEWS_FRESH_FOR_MS &&
    fingerprintsMatch(input)
  ) {
    return "fresh";
  }
  return "stale";
}

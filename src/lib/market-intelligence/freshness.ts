import type { MarketIntelligenceState } from "./types";

export const NEWS_FRESH_FOR_MS = 60 * 60 * 1000;
export const NEWS_DEGRADED_AFTER_MS = 48 * 60 * 60 * 1000;

export type FreshnessInput = {
  hasUsableContent: boolean;
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

  const checkedAt = Date.parse(input.newsCheckedAt ?? "");
  const now =
    input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now();
  const age = now - checkedAt;

  if (Number.isNaN(checkedAt)) return "stale";
  if (age >= NEWS_DEGRADED_AFTER_MS) return "hard_expired";
  if (input.lastErrorCode) return "degraded";
  if (age <= NEWS_FRESH_FOR_MS && fingerprintsMatch(input)) return "fresh";
  return "stale";
}

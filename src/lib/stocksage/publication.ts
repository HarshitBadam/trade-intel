import type { ChatQuote } from "@/lib/market-data";
import {
  expandValidCitations,
  stripTickerCitationMarkers,
  validCitationUrls,
} from "./citations";
import { unsupportedFigures } from "./figures";
import {
  coversEveryEntity,
  opensOnSubject,
  performsSmuggledTask,
  violatesStyle,
} from "./regular-guards-core";
import {
  firstPersonVerificationLimitation,
  hedgedEstimateClaim,
  investmentDirectionClaim,
  missingCriteria,
  proxyMisrepresentation,
  repeatedPriorPhrase,
  uncitedResearchClaimUnits,
} from "./regular-guards-evidence";
import { roundFiguresForDisplay } from "./rounding";
import type { EvidenceSource, FinanceEntity } from "./types";

/**
 * The single publication contract shared by regular answers in `answer.ts`
 * and Deep Research in `deep/worker.ts`. This module
 * only holds pure validation/publication helpers: it never routes, retrieves,
 * or calls a model. See the `publication-contract` step of the
 * `unified-stocksage-engine` plan.
 *
 * The explicit regular and deep check profiles document which rules apply at
 * each publication depth.
 */

export type PublicationRejectionReason =
  | "unsupported_figures"
  | "hedged_estimate"
  | "proxy_misrepresentation"
  | "uncited_research_claims"
  | "investment_direction"
  | "limitation_language"
  | "missing_citations"
  | "off_topic_leak"
  | "blended_off_topic_leak"
  | "social_market_claim"
  | "curt_farewell"
  | "missing_criteria"
  | "wrong_subject_opening"
  | "incomplete_entity_coverage"
  | "style"
  | "repeated_prior_phrase";

/** Every structured rejection reason code a publication check can produce. */
export const PUBLICATION_REJECTION_REASONS: readonly PublicationRejectionReason[] =
  [
    "unsupported_figures",
    "hedged_estimate",
    "proxy_misrepresentation",
    "uncited_research_claims",
    "investment_direction",
    "limitation_language",
    "missing_citations",
    "off_topic_leak",
    "blended_off_topic_leak",
    "social_market_claim",
    "curt_farewell",
    "missing_criteria",
    "wrong_subject_opening",
    "incomplete_entity_coverage",
    "style",
    "repeated_prior_phrase",
  ];

export type PublicationRejection = {
  reasonCode: PublicationRejectionReason;
  detail?: string;
};

/**
 * A rejection reason is "enabled" for a given evaluation when the value is
 * `true`. `repeated_prior_phrase` is intentionally excluded: it depends on a
 * per-request attempt counter (only the first repetition rejection triggers a
 * rewrite), so callers evaluate it themselves via
 * `repeatedPriorPhraseRejection` after `evaluatePublicationCandidate` passes.
 */
export type PublicationCheckSet = Partial<
  Record<Exclude<PublicationRejectionReason, "repeated_prior_phrase">, boolean>
>;

export type PublicationCandidateContext = {
  /** Draft/system/user text the figure and hedge checks treat as evidence. */
  corpus: string;
  entities: FinanceEntity[];
  quotes: ChatQuote[];
  sources: EvidenceSource[];
  requestedCriteria: string[];
  hasSources: boolean;
  /** Required when `off_topic_leak` is enabled. */
  offTopicLeakDetector?: (candidate: string) => boolean;
  /** Required when `social_market_claim` is enabled. */
  socialMarketClaimPattern?: RegExp;
  /** Minimum accepted length for `curt_farewell`; defaults to 20. */
  farewellMinLength?: number;
};

/**
 * Runs the enabled checks in a fixed canonical order (matching the order the
 * unified regular engine has always evaluated them in) and returns the first
 * failure, or `null` when the candidate clears every enabled check. Order is
 * only externally observable for the regular engine's telemetry; Deep
 * Research and the legacy regular engine only ever consume the pass/fail
 * boolean, so reordering never changes accept/reject outcomes for deep work.
 */
export function evaluatePublicationCandidate(
  candidate: string,
  enabled: PublicationCheckSet,
  ctx: PublicationCandidateContext
): PublicationRejection | null {
  if (enabled.unsupported_figures) {
    const invented = unsupportedFigures(candidate, ctx.corpus);
    if (invented.length > 0) {
      return { reasonCode: "unsupported_figures", detail: invented.join(", ") };
    }
  }
  if (enabled.hedged_estimate) {
    const hedged = hedgedEstimateClaim(candidate, ctx.corpus);
    if (hedged) return { reasonCode: "hedged_estimate", detail: hedged };
  }
  if (enabled.proxy_misrepresentation) {
    const proxyError = proxyMisrepresentation(candidate, ctx.entities, ctx.quotes);
    if (proxyError) {
      return { reasonCode: "proxy_misrepresentation", detail: proxyError };
    }
  }
  if (enabled.uncited_research_claims) {
    const uncited = uncitedResearchClaimUnits(candidate, ctx.sources);
    if (uncited.length > 0) {
      return {
        reasonCode: "uncited_research_claims",
        detail: uncited.join(" | "),
      };
    }
  }
  if (enabled.investment_direction) {
    const direction = investmentDirectionClaim(candidate);
    if (direction) return { reasonCode: "investment_direction", detail: direction };
  }
  if (enabled.limitation_language) {
    const limitation = firstPersonVerificationLimitation(candidate);
    if (limitation) {
      return { reasonCode: "limitation_language", detail: limitation };
    }
  }
  if (enabled.missing_citations) {
    if (validCitationUrls(candidate, ctx.sources).length === 0) {
      return { reasonCode: "missing_citations" };
    }
  }
  if (enabled.off_topic_leak && ctx.offTopicLeakDetector?.(candidate)) {
    return { reasonCode: "off_topic_leak" };
  }
  if (enabled.blended_off_topic_leak && performsSmuggledTask(candidate)) {
    return { reasonCode: "blended_off_topic_leak" };
  }
  if (
    enabled.social_market_claim &&
    ctx.socialMarketClaimPattern?.test(candidate)
  ) {
    return { reasonCode: "social_market_claim" };
  }
  if (
    enabled.curt_farewell &&
    candidate.trim().length < (ctx.farewellMinLength ?? 20)
  ) {
    return { reasonCode: "curt_farewell" };
  }
  if (enabled.missing_criteria) {
    const unmet = missingCriteria(candidate, ctx.requestedCriteria);
    if (unmet.length > 0) {
      return { reasonCode: "missing_criteria", detail: unmet.join(", ") };
    }
  }
  if (enabled.wrong_subject_opening && !opensOnSubject(candidate, ctx.entities)) {
    return { reasonCode: "wrong_subject_opening" };
  }
  if (
    enabled.incomplete_entity_coverage &&
    !coversEveryEntity(candidate, ctx.entities)
  ) {
    return { reasonCode: "incomplete_entity_coverage" };
  }
  if (enabled.style) {
    const style = violatesStyle(candidate, ctx.hasSources);
    if (style !== null) return { reasonCode: "style", detail: style };
  }
  return null;
}

/**
 * Checks applied by the single regular answer path. The contract covers
 * uncited current-world
 * research claims, investment-direction language, first-person verification
 * limitations, off-topic/blended-off-topic leaks, unsolicited social market
 * claims, and curt farewells.
 */
export function regularSynthesisChecks(args: {
  guardFigures: boolean;
  requireCitations: boolean;
  requireCoverage: boolean;
  wantsData: boolean;
  offTopicTurn: boolean;
  blendedOffTopic: boolean;
  farewellTurn: boolean;
}): PublicationCheckSet {
  return {
    unsupported_figures: args.guardFigures,
    hedged_estimate: args.guardFigures,
    proxy_misrepresentation: true,
    uncited_research_claims: args.wantsData,
    investment_direction: true,
    limitation_language: true,
    missing_citations: args.requireCitations,
    off_topic_leak: args.offTopicTurn,
    blended_off_topic_leak: args.blendedOffTopic,
    social_market_claim: !args.wantsData,
    curt_farewell: args.farewellTurn,
    missing_criteria: true,
    wrong_subject_opening: args.requireCoverage,
    incomplete_entity_coverage: args.requireCoverage,
    style: true,
  };
}

/**
 * Checks applied by Deep Research (`deep/worker.ts`). Deep Research always requires
 * at least one valid citation and never applies the regular engine's
 * criteria-coverage, subject-opening, style, or repetition checks: a deep
 * report is a single-pass research document, not a conversational reply.
 */
export function deepSynthesisChecks(args: { smuggled: boolean }): PublicationCheckSet {
  return {
    missing_citations: true,
    uncited_research_claims: true,
    investment_direction: true,
    limitation_language: true,
    unsupported_figures: true,
    hedged_estimate: true,
    proxy_misrepresentation: true,
    blended_off_topic_leak: args.smuggled,
  };
}

export type FinalizePublicationTextOptions = {
  /** Tickers to strip stray `[TICKER]` markers for, e.g. from quote symbols. */
  tickers?: string[];
  /** Strip ticker citation markers before expanding/rounding. */
  stripTickers?: boolean;
  /** Trim the (possibly ticker-stripped) text before expanding/rounding. */
  trim?: boolean;
};

/**
 * The one place every successful synthesis or fallback path turns a raw
 * draft into published output: optional ticker-marker stripping, valid
 * citation URL extraction, `[S#]` citation expansion to markdown links, and
 * numeric rounding for display. Citation URLs are always computed from the
 * same (stripped/trimmed) text that is expanded, matching every existing
 * call site's behavior.
 */
export function finalizePublicationText(
  rawText: string,
  sources: EvidenceSource[],
  options: FinalizePublicationTextOptions = {}
): { text: string; citationUrls: string[]; cleaned: string } {
  let cleaned = options.stripTickers
    ? stripTickerCitationMarkers(rawText, options.tickers ?? [])
    : rawText;
  if (options.trim) cleaned = cleaned.trim();
  return {
    cleaned,
    citationUrls: validCitationUrls(cleaned, sources),
    text: roundFiguresForDisplay(expandValidCitations(cleaned, sources)),
  };
}

/**
 * Thin wrapper so callers can report `repeated_prior_phrase` through the same
 * `PublicationRejection` shape as `evaluatePublicationCandidate`. Kept
 * separate because it depends on a per-request "only reject once" attempt
 * counter that only the caller (the synthesis loop) owns.
 */
export function repeatedPriorPhraseRejection(
  candidate: string,
  priorReplies: string[],
  entities: FinanceEntity[] = []
): PublicationRejection | null {
  const repeated = repeatedPriorPhrase(candidate, priorReplies, entities);
  return repeated ? { reasonCode: "repeated_prior_phrase", detail: repeated } : null;
}


import "server-only";

import { randomUUID } from "node:crypto";
import { createDeepResearchOffer } from "./deep-snapshot";
import { answerDegraded } from "./chat-heuristics";
import {
  expandValidCitations,
  stripTickerCitationMarkers,
  validCitationUrls,
} from "./citations";
import { detectCriteria } from "./conversation-attributes";
import {
  resolveConversationState,
  type StateResolution,
} from "./entities";
import { unsupportedFigures } from "./figures";
import { buildGroundedDeterministicReply } from "./grounded-answer";
import { planEvidence } from "./planning";
import { roundFiguresForDisplay } from "./rounding";
import {
  buildDeterministicRankingReply,
  buildFallbackReply,
} from "./regular-fallback";
import { buildUnifiedSystemPrompt } from "./regular-prompt";
import { historyMessages } from "./regular-history";
import {
  coversEveryEntity,
  creativeRequestOnly,
  firstPersonVerificationLimitation,
  hasSmuggledOffTopicTask,
  hedgedEstimateClaim,
  investmentDirectionClaim,
  missingCriteria,
  opensOnSubject,
  performsSmuggledTask,
  proxyMisrepresentation,
  repeatedPriorPhrase,
  uncitedResearchClaimUnits,
  violatesStyle,
} from "./regular-guards";
import { executeEvidencePlan, type RegularContext } from "./retrieve";
import {
  ABUSE_AT_BOT,
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
  FRUSTRATION,
  HELP,
  SOCIAL,
} from "./social-patterns";
import { synthesizeWithFallback } from "./synthesis";
import { logStockSage } from "./telemetry";
import type { ChatDependencies } from "./chat-shared";
import type {
  ChatDataStatus,
  ChatReply,
  ChatRequest,
} from "./types";

// Everything in this file that inspects the message decides only WHAT DATA TO
// PREFETCH — never what the user meant. Meaning is resolved by the model from
// the raw conversation. A wrong guess here costs a missing or wasted fetch,
// not a wrong answer.

const TIME_OR_MARKET =
  /\b(?:latest|today|yesterday|now|current(?:ly)?|recent(?:ly)?|lately|news|update|earnings|guidance|price|trading|move[ds]?|moving|perform(?:s|ed|ing|ance)?|outlook|this (?:week|month|quarter|year)|month[- ]to[- ]date|mtd|trailing month|last (?:few days|week|month|quarter|year)|ytd|year[- ]to[- ]date|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|market|portfolio|nasdaq|nyse|asx|s&p|dow|fed|rates?|inflation|valuation|p\/?e|dividend|risks?|risky|volatil|rank|compare|vs\.?|versus|bigger|safer|cheaper)\b/i;

const CLEARLY_ELSEWHERE =
  /\b(?:joke|poem|essay|story|lyrics|weather|recipe|movie|music|celebrity|football|soccer|cricket|basketball|nba|nfl|afl|dating|crush|girlfriend|boyfriend|ask (?:someone|her|him|them) out|homework|python|javascript|typescript|code|script|derive|gravity|physics)\b/i;

const DATA_SEEKING_FOLLOW_UP =
  /^(?:(?:and|so|then)\s+)?(?:which developments?\b.*\bmatters?|what\b.*\bmatters?|why(?:\s+(?:does|did|is|was|would|could|that|this|it|so))?\b|what are the (?:main|key) catalysts?|which catalyst\b|what should investors? watch\b|summari[sz]e\b.*\b(?:bull|bear|risk|outlook|case))/i;

// A refusal that still performs the task (prints the loop output, states the
// gravity formula, hands out dating advice) is the leak the audits kept
// finding. An off-topic decline needs none of these: code punctuation,
// digits, formula/output talk, or more than a couple of sentences.
const OFF_TOPIC_LEAK =
  /[=`{}]|\d|\bformula\b|\boutputs?\b|\bwould (?:print|return|be|look like|give)\b|\bderiv(?:e[sd]?|ation)\b|\bprints?\b|\bloops?\b(?!\s*(?:back|in))|\bequations?\b/i;

function leaksOffTopicWork(candidate: string): boolean {
  if (candidate.length > 320) return true;
  if (OFF_TOPIC_LEAK.test(candidate)) return true;
  const sentences = candidate
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim().length > 0);
  return sentences.length > 3;
}

// Small talk has no retrieved evidence behind it, so it must not assert what
// markets are doing today ("quiet day", "seeing movement in tech").
const SOCIAL_MARKET_CLAIM =
  /\b(?:markets?|stocks?|tech|nasdaq|s&p|dow)\b[^.!?\n]{0,50}\b(?:up|down|red|green|quiet|choppy|volatile|rall(?:y(?:ing)?|ied)|sell(?:ing)?[- ]?off|surg(?:e|ing)|slid(?:e|ing)?|dropp(?:ed|ing)|climb(?:ed|ing)|mov(?:ed|ing)|movement|action)\b|\b(?:quiet|choppy|volatile|busy|wild|red|green|movement|action)\b[^.!?\n]{0,30}\b(?:markets?|stocks?|session|day)\b|\bgood session\b/i;

function isPureSocialTurn(message: string): boolean {
  // The anchored whole-message patterns (greetings, farewells,
  // acknowledgements, help) win outright — "bye for now" must not become a
  // data turn just because "now" looks like a time word.
  if (
    SOCIAL.test(message) ||
    FAREWELL.test(message) ||
    CASUAL_ACKNOWLEDGEMENT.test(message) ||
    HELP.test(message)
  ) {
    return true;
  }
  if (TIME_OR_MARKET.test(message)) return false;
  return FRUSTRATION.test(message) || ABUSE_AT_BOT.test(message);
}

function emptyContext(asOf: string): RegularContext {
  return {
    quotes: [],
    fundamentals: [],
    sources: [],
    coverage: {},
    plan: {
      version: 1,
      route: "general",
      asOf,
      queries: [],
      requiredEntityIds: [],
      criteria: [],
    },
  };
}

function dataStatusFor(
  wantsData: boolean,
  context: RegularContext
): ChatDataStatus {
  if (!wantsData) return "full";
  const hasData =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  if (!hasData) return "unavailable";
  const coverage = Object.values(context.coverage);
  return coverage.some((value) => value === "missing") ? "limited" : "full";
}

export async function answerWithModel(
  request: ChatRequest,
  dependencies: ChatDependencies,
  startedAt: number,
  presolved?: StateResolution
): Promise<ChatReply> {
  // chat.ts already resolved this exact message for the safety floor; reuse
  // that resolution so both layers always act on identical state.
  const resolution =
    presolved ??
    resolveConversationState(request.message, request.state, request.history);
  const entities = resolution.entities;
  const social = isPureSocialTurn(request.message);
  const elsewhere = CLEARLY_ELSEWHERE.test(request.message);
  const smuggled = hasSmuggledOffTopicTask(request.message);
  // "Write me a haiku about nvidia's stock price" is a haiku request, not a
  // finance question — a creative task stays off-topic no matter how many
  // tickers appear inside it. Only a separate finance ask riding alongside
  // ("…then compare tesla and rivian") keeps the turn a data turn.
  const creativeOnly = creativeRequestOnly(request.message);
  // A named finance subject keeps the turn a data turn even when off-topic
  // content rides along; without one, off-topic keywords veto the fetch.
  const wantsData =
    !social &&
    !creativeOnly &&
    (entities.length > 0 ||
      (resolution.state.entities.length > 0 &&
        DATA_SEEKING_FOLLOW_UP.test(request.message)) ||
      (!elsewhere && TIME_OR_MARKET.test(request.message)));
  const offTopicTurn =
    !social && !wantsData && (elsewhere || smuggled || creativeOnly);
  // A sign-off deserves a human send-off, not a bare "Bye!".
  const farewellTurn = social && FAREWELL.test(request.message);
  // Finance turns that also smuggle an off-topic task ("what's 2**10? also
  // how's nvidia doing"): the finance half gets answered, the smuggled half
  // must be declined without being performed — partial leakage is the same
  // failure as full leakage.
  const blendedOffTopic = wantsData && (elsewhere || smuggled);

  // Follow-up turns ("what are the main risks", "vs amd") rarely re-name
  // their subjects, so a turn that resolved no entities of its own prefetches
  // for the conversation's active set instead — otherwise every follow-up
  // ships zero sources and precise figures go out uncited.
  const prefetchEntities =
    entities.length > 0 ? entities : resolution.state.entities;
  const plan = wantsData
    ? planEvidence({
        route: prefetchEntities.length >= 2 ? "comparison" : "current_finance",
        message: request.message,
        entities: prefetchEntities,
        state: resolution.state,
      })
    : undefined;
  const retrievalStartedAt = Date.now();
  const context = plan
    ? await executeEvidencePlan({
        plan,
        entities: prefetchEntities,
        providers: dependencies.retrievalProviders,
      })
    : emptyContext(new Date().toISOString());
  const retrievalMs = Date.now() - retrievalStartedAt;
  const live =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  const dataStatus = dataStatusFor(wantsData, context);
  const requestedCriteria = wantsData ? detectCriteria(request.message) : [];
  const deterministicRanking = buildDeterministicRankingReply(
    request,
    prefetchEntities,
    context,
    resolution.state.horizon
  );
  if (deterministicRanking) {
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_numeric_ranking",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...deterministicRanking,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
      dataStatus:
        deterministicRanking.retryable === true ? "limited" : dataStatus,
    };
  }

  if (blendedOffTopic && wantsData && context.quotes.length > 0) {
    const fallback = buildFallbackReply(
      request,
      {
        route:
          prefetchEntities.length >= 2 ? "comparison" : "current_finance",
        reasonCode: "deterministic_scope_contained_snapshot",
        retrievalRequired: true,
        deepEligible: false,
      },
      prefetchEntities,
      context
    );
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_scope_contained_snapshot",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
      dataStatus,
    };
  }

  const asxProxySnapshot =
    prefetchEntities.length === 1 &&
    context.quotes.length === 1 &&
    context.quotes[0].ticker === "AXJO" &&
    context.quotes[0].proxySymbol === "EWA" &&
    /\b(?:today|latest session|doing|done)\b/i.test(request.message);
  if (asxProxySnapshot) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "current_finance",
        reasonCode: "deterministic_proxy_snapshot",
        retrievalRequired: true,
        deepEligible: false,
      },
      prefetchEntities,
      context
    );
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_proxy_snapshot",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
      dataStatus,
    };
  }

  // Quote-led single-entity updates are structured data, not a prose
  // generation problem. Publishing them deterministically avoids multi-lane
  // retries when a provider omits proxy wording or invents context, while
  // still attaching any independently accepted sources for Deep preflight.
  // News/research-seeking asks are excluded even when a quote rides along:
  // "latest cited Nvidia news" must reach the grounded cited answer below,
  // not be preempted by a price snapshot just because "latest" matched.
  const newsOrResearchSeeking =
    /\b(?:news|headlines?|developments?|catalysts?|cited|articles?|announce\w*|guidance|outlook|bull case|bear case|risks?)\b/i.test(
      request.message
    );
  const deterministicMarketSnapshot =
    prefetchEntities.length === 1 &&
    context.quotes.length > 0 &&
    !newsOrResearchSeeking &&
    /\b(?:what(?:'?s| is) up|how\b.{0,50}\b(?:doing|done|performing|closed?)|price|trading at|latest|today|this week|last week|last month|last year|year[- ]to[- ]date|ytd)\b/i.test(
      request.message
    );
  if (deterministicMarketSnapshot) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "current_finance",
        reasonCode: "deterministic_market_snapshot",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_market_snapshot",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }

  const deterministicProxyComparison =
    prefetchEntities.length >= 2 &&
    context.quotes.some((quote) => Boolean(quote.proxySymbol));
  if (deterministicProxyComparison) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "comparison",
        reasonCode: "deterministic_proxy_comparison",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_proxy_comparison",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }

  const deterministicInvestabilityComparison =
    prefetchEntities.length >= 2 &&
    prefetchEntities.some((entity) => entity.private) &&
    (context.quotes.length > 0 ||
      context.fundamentals.length > 0 ||
      context.sources.length > 0);
  if (deterministicInvestabilityComparison) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "comparison",
        reasonCode: "deterministic_investability_comparison",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_investability_comparison",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }

  const deterministicStructuredComparison =
    prefetchEntities.length >= 2 &&
    (context.quotes.length >= 2 || context.fundamentals.length >= 2);
  if (deterministicStructuredComparison) {
    const fallback = buildFallbackReply(
      request,
      {
        route: "comparison",
        reasonCode: "deterministic_structured_comparison",
        retrievalRequired: true,
        deepEligible: context.sources.length > 0,
      },
      prefetchEntities,
      context
    );
    const citationUrls = fallback.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: fallback.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_structured_comparison",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...fallback,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  }

  const grounded = wantsData
    ? buildGroundedDeterministicReply(request, prefetchEntities, context)
    : null;
  if (grounded) {
    const citationUrls = grounded.citationUrls ?? [];
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text: grounded.text, live, citationUrls },
      entities: prefetchEntities,
      state: resolution.state,
      sources: context.sources,
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_grounded_answer",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...grounded,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus: grounded.retryable ? "limited" : dataStatus,
    };
  }

  const sourceLessCurrentResearch =
    wantsData &&
    context.sources.length === 0 &&
    (/\b(?:news|development|catalyst|guidance|outlook|next[- ]quarter|bull case|bear case|risks?)\b/i.test(
      request.message
    ) ||
      requestedCriteria.some((criterion) =>
        ["risk", "outlook", "earnings"].includes(criterion)
      ));
  if (sourceLessCurrentResearch && live) {
    const fallback = buildFallbackReply(
      request,
      {
        route:
          prefetchEntities.length >= 2 ? "comparison" : "current_finance",
        reasonCode: "source_less_research_floor",
        retrievalRequired: true,
        deepEligible: false,
      },
      prefetchEntities,
      context
    );
    const text = roundFiguresForDisplay(fallback.text);
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text, live, citationUrls: [] },
      entities: prefetchEntities,
      state: resolution.state,
      sources: [],
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "source_less_research_floor",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: 0,
    });
    return {
      ...fallback,
      text,
      live,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus: "limited",
    };
  }

  // Total data outage is the deterministic floor, not a prompt-writing task.
  // Letting an LLM answer here produced plausible but stale encyclopedia prose
  // ("the ASX is an exchange...") and first-person limitation narration. The
  // fallback is subject-aware, preserves verified private-company facts, and
  // carries an unavailable research offer without inventing content.
  if (wantsData && !live) {
    const fallback = buildFallbackReply(
      request,
      {
        route:
          prefetchEntities.length >= 2 ? "comparison" : "current_finance",
        reasonCode: "zero_data_floor",
        retrievalRequired: true,
        deepEligible: true,
      },
      prefetchEntities,
      context
    );
    const text = roundFiguresForDisplay(fallback.text);
    const deep = createDeepResearchOffer({
      question: request.message,
      reply: { text, live: false, citationUrls: [] },
      entities: prefetchEntities,
      state: resolution.state,
      sources: [],
      asOf: context.plan.asOf,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "zero_data_floor",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: 0,
    });
    return {
      ...fallback,
      text,
      live: false,
      kind: "answer",
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus: "unavailable",
    };
  }

  const system = buildUnifiedSystemPrompt({
    entities: prefetchEntities,
    quotes: context.quotes,
    fundamentals: context.fundamentals,
    sources: context.sources,
    evidenceGap: Boolean(plan) && plan!.queries.length > 0 && !live,
  });
  const figureCorpus = [
    system,
    ...request.history
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text),
    request.message,
  ].join("\n");
  // Concept answers with no subjects and no live data may use illustrative
  // numbers; anything tied to real entities or retrieved evidence may not.
  const guardFigures = prefetchEntities.length > 0 || live;
  // Sources are optional for quote-only statements, but once a data-seeking
  // answer makes fresh/news-type claims while sources exist, at least one
  // source must survive publication. Quotes/fundamentals no longer disable
  // this guard.
  const requireCitations = wantsData && context.sources.length > 0;
  // A comparison that only ever discusses one side is a silent substitution,
  // not an answer — this parallels the older heuristics path's guard, which
  // was not carried over when the single-model-call path was introduced.
  const requireCoverage = wantsData && entities.length >= 2;
  const priorReplies = request.history
    .filter((turn) => turn.role === "ai")
    .slice(-3)
    .map((turn) => turn.text);

  const synthesisStartedAt = Date.now();
  try {
    let repetitionRejections = 0;
    const text = await synthesizeWithFallback({
      system,
      history: historyMessages(request),
      user: request.message,
      maxTokens: 700,
      temperature: 0.55,
      timeoutMs: 18_000,
      totalTimeoutMs: 24_000,
      event: "regular_synthesis",
      lane: "full",
      accept: (candidate) => {
        const reject = (reason: string, detail?: string) => {
          console.error(
            `[stocksage] ${JSON.stringify({
              event: "publication_reject",
              reason,
              ...(detail ? { detail: detail.slice(0, 120) } : {}),
            })}`
          );
          return false;
        };
        const invented = guardFigures
          ? unsupportedFigures(candidate, figureCorpus)
          : [];
        if (invented.length > 0) {
          return reject("unsupported_figures", invented.join(", "));
        }
        const hedged = guardFigures
          ? hedgedEstimateClaim(candidate, figureCorpus)
          : null;
        if (hedged) return reject("hedged_estimate", hedged);
        const proxyError = proxyMisrepresentation(
          candidate,
          prefetchEntities,
          context.quotes
        );
        if (proxyError) return reject("proxy_misrepresentation", proxyError);
        const uncitedClaims = wantsData
          ? uncitedResearchClaimUnits(candidate, context.sources)
          : [];
        if (uncitedClaims.length > 0) {
          return reject("uncited_research_claims", uncitedClaims.join(" | "));
        }
        const direction = investmentDirectionClaim(candidate);
        if (direction) return reject("investment_direction", direction);
        const limitation = firstPersonVerificationLimitation(candidate);
        if (limitation) return reject("first_person_limitation", limitation);
        if (
          requireCitations &&
          validCitationUrls(candidate, context.sources).length === 0
        ) {
          return reject("missing_citations");
        }
        if (offTopicTurn && leaksOffTopicWork(candidate)) {
          return reject("off_topic_leak");
        }
        // Applies to blended turns AND pure task requests (a delivered haiku
        // has no digits, so leaksOffTopicWork alone won't see it).
        if ((blendedOffTopic || smuggled) && performsSmuggledTask(candidate)) {
          return reject("blended_off_topic_leak");
        }
        if (!wantsData && SOCIAL_MARKET_CLAIM.test(candidate)) {
          return reject("social_market_claim");
        }
        if (farewellTurn && candidate.trim().length < 20) {
          return reject("curt_farewell");
        }
        const unmet = missingCriteria(candidate, requestedCriteria);
        if (unmet.length > 0) return reject("missing_criteria", unmet.join(", "));
        if (requireCoverage && !opensOnSubject(candidate, entities)) {
          return reject("wrong_subject_opening");
        }
        if (requireCoverage && !coversEveryEntity(candidate, entities)) {
          return reject("incomplete_entity_coverage");
        }
        const style = violatesStyle(candidate, context.sources.length > 0);
        if (style !== null) return reject("style", style);
        if (
          repetitionRejections === 0 &&
          repeatedPriorPhrase(candidate, priorReplies, entities) !== null
        ) {
          repetitionRejections += 1;
          return reject("repeated_prior_phrase");
        }
        return true;
      },
      correction: (draft) => {
        const invented = guardFigures
          ? unsupportedFigures(draft, figureCorpus)
          : [];
        const style = violatesStyle(draft, context.sources.length > 0);
        const hedged = guardFigures
          ? hedgedEstimateClaim(draft, figureCorpus)
          : null;
        const proxyError = proxyMisrepresentation(
          draft,
          prefetchEntities,
          context.quotes
        );
        const uncitedClaims = wantsData
          ? uncitedResearchClaimUnits(draft, context.sources)
          : [];
        const direction = investmentDirectionClaim(draft);
        const limitation = firstPersonVerificationLimitation(draft);
        const unmetCriteria = missingCriteria(draft, requestedCriteria);
        const repeated = repeatedPriorPhrase(draft, priorReplies, entities);
        const leaked = offTopicTurn && leaksOffTopicWork(draft);
        const blendedLeak =
          (blendedOffTopic || smuggled) && performsSmuggledTask(draft);
        const marketClaim = !wantsData && SOCIAL_MARKET_CLAIM.test(draft);
        const wrongOpening =
          requireCoverage && !opensOnSubject(draft, entities);
        const missingEntities =
          requireCoverage && !coversEveryEntity(draft, entities)
            ? entities.filter(
                (entity) => !coversEveryEntity(draft, [entity])
              )
            : [];
        return `Rewrite that reply. ${
          leaked
            ? "This request is outside StockSage's lane. Reply with ONE friendly sentence saying so, plus at most one finance pivot. It must contain no numbers, code, outputs, formulas, derivations, advice, or any partial completion of the request itself. "
            : ""
        }${
          blendedLeak
            ? "This message asks for an off-topic task (a calculation, code, a poem/haiku/story, or similar). Never perform any of it — no result, no equation, no output, no verse or creative writing, even when the subject is a stock. If a genuine finance question rides alongside, answer that part; otherwise one friendly sentence that it's outside your lane. "
            : ""
        }${
          marketClaim
            ? "You asserted what markets or stocks are doing right now, but you have no market data in this turn — drop every claim about current market conditions and keep it purely conversational. "
            : ""
        }${
          farewellTurn && draft.trim().length < 20
            ? "That send-off was too curt — give it one warm, natural sentence that matches the user's tone, with no question or pitch. "
            : ""
        }${
          invented.length > 0
            ? `These figures are not in the data you were given, so they must go: ${invented.join(
                ", "
              )}. Do not replace them with other numbers from memory — state only figures present in the data, and where a figure is missing, say what you'd check instead. `
            : ""
        }${
          hedged
            ? `This hedged market-performance estimate is not supported by a retrieved figure and must be removed: "${hedged}". Do not replace it with a range, approximation, or remembered estimate. `
            : ""
        }${
          proxyError
            ? `You misrepresented proxy data: "${proxyError}". Name the ETF/ADR symbol, call it a proxy, and attribute every price and return to that ETF/ADR — never to the requested index or local listing. `
            : ""
        }${
          uncitedClaims.length > 0
            ? `These current research claim units have no valid citation in their own sentence or bullet. Add the supporting [S#] to each unit, explicitly frame a cited inference, or remove the unit: ${uncitedClaims
                .map((unit) => `"${unit}"`)
                .join(" | ")}. A citation in another bullet does not count. `
            : ""
        }${
          direction
            ? `Remove this investment-direction language: "${direction}". Describe the evidence neutrally; do not call a move a buying or selling opportunity. `
            : ""
        }${
          limitation
            ? `Replace this first-person limitation with neutral gap wording: "${limitation}". For example: "Current guidance was not present in the available reporting." `
            : ""
        }${
          unmetCriteria.length > 0
            ? `The user specifically asked about ${unmetCriteria.join(
                " and "
              )}, and your draft never addressed it. Address it with the data you were given, or use one neutral clause naming what was not present in the available reporting — do not answer a different question. `
            : ""
        }${
          wrongOpening
            ? `You opened with the wrong subject. This turn is about exactly: ${entities
                .map((entity) => entity.name)
                .join(", ")} — open with one of them, not something else. `
            : ""
        }${
          missingEntities.length > 0
            ? `You dropped ${missingEntities
                .map((entity) => entity.name)
                .join(
                  ", "
                )} entirely. Cover every one of ${entities
                .map((entity) => entity.name)
                .join(", ")} with the same criteria, or name the specific gap for whichever one you lack data on — never just omit it. `
            : ""
        }${style ? `${style} ` : ""}${
          repeated
            ? `You reused near-identical wording from your earlier answers ("…${repeated}…") — say new things in new words this turn. `
            : ""
        }${
          requireCitations
            ? "Cite the source ID like [S1] after every claim taken from SOURCES. "
            : ""
        }Output only the final reply — never apologize for or mention the rewrite, this instruction, or the earlier draft. Keep the same voice and length.`;
      },
    });
    const synthesisMs = Date.now() - synthesisStartedAt;
    const cleaned = stripTickerCitationMarkers(
      text,
      context.quotes.map((quote) => quote.ticker)
    ).trim();
    const citationUrls = validCitationUrls(cleaned, context.sources);
    const finalText = roundFiguresForDisplay(
      expandValidCitations(cleaned, context.sources)
    );
    const deep =
      wantsData
        ? createDeepResearchOffer({
            question: request.message,
            reply: { text: finalText, live, citationUrls },
            entities: prefetchEntities,
            state: resolution.state,
            sources: context.sources,
            asOf: context.plan.asOf,
          })
        : { responseId: randomUUID() };
    logStockSage({
      event: "request_complete",
      route: wantsData ? "model_finance" : "model_conversational",
      reasonCode: "single_model_call",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      synthesisMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      text: finalText,
      live,
      kind: "answer",
      citationUrls,
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  } catch {
    // Every LLM lane failed or every draft failed publication checks.
    // Timeless definitional questions (P/E, dividend yield, market cap…) have
    // canned answers that beat a source dump; anything asking for current
    // facts or rankings must not get a definition instead of its answer.
    const definitional =
      /\b(?:what(?:'?s| is| are| does)|explain|define|mean[s]?|how (?:do(?:es)?|is|are) .{0,40}(?:work|calculated|defined|measured))\b/i.test(
        request.message
      ) && !/\b(?:top|rank|largest|biggest|best|list|who)\b/i.test(request.message);
    const concept = definitional
      ? buildFallbackReply(
          request,
          {
            route: "stable_finance",
            reasonCode: "degraded_concept",
            retrievalRequired: false,
            deepEligible: false,
          },
          entities,
          emptyContext(context.plan.asOf)
        )
      : { retryable: true as const, text: "", citationUrls: [] };
    if (!concept.retryable) {
      logStockSage({
        event: "request_complete",
        route: "stable_finance",
        reasonCode: "degraded_concept",
        durationMs: Date.now() - startedAt,
        providerCount: 0,
      });
      return {
        ...concept,
        live: false,
        kind: "answer",
        responseId: randomUUID(),
        state: resolution.state,
        dataStatus: "full",
      };
    }
    // If the retrieval step already produced verified market data, publish
    // that deterministically — the user still gets an answer, not boilerplate.
    if (live) {
      const fallback = buildFallbackReply(
        request,
        {
          route: prefetchEntities.length >= 2 ? "comparison" : "current_finance",
          reasonCode: "degraded_from_data",
          retrievalRequired: true,
          deepEligible: false,
        },
        prefetchEntities,
        context
      );
      const citationUrls = fallback.citationUrls ?? [];
      const deep = wantsData
        ? createDeepResearchOffer({
            question: request.message,
            reply: { text: fallback.text, live, citationUrls },
            entities: prefetchEntities,
            state: resolution.state,
            sources: context.sources,
            asOf: context.plan.asOf,
          })
        : { responseId: randomUUID() };
      logStockSage({
        event: "request_complete",
        route: "model_finance",
        reasonCode: "degraded_from_data",
        durationMs: Date.now() - startedAt,
        retrievalMs,
        providerCount: context.plan.queries.length,
        sourceCount: context.sources.length,
      });
      return {
        ...fallback,
        live,
        kind: "answer",
        responseId: deep.responseId,
        deepResearch: deep.offer,
        state: resolution.state,
        dataStatus: "limited",
      };
    }
    // No data either: one honest, retryable, state-preserving reply beats an
    // impersonation.
    return {
      ...answerDegraded(request, startedAt),
      dataStatus: wantsData ? "unavailable" : "full",
    };
  }
}

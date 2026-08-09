import "server-only";

import { randomUUID } from "node:crypto";
import type { RequestBudget } from "./budget";
import { withDeadline } from "./budget";
import { answerDegraded } from "./degraded-answer";
import { deterministicModelAnswer } from "./deterministic-answer";
import { createDeepResearchOffer } from "./deep/snapshot";
import { detectCriteria } from "./conversation-attributes";
import { presentationModeFor } from "./chat-shared";
import { buildGroundedDeterministicReply } from "./grounded-answer";
import { hasSmuggledOffTopicTask, repeatedPriorPhrase } from "./regular-guards";
import { historyMessages } from "./regular-history";
import { buildFallbackReply } from "./regular-fallback";
import { buildUnifiedSystemPrompt } from "./regular-prompt";
import {
  evaluatePublicationCandidate,
  finalizePublicationText,
  regularSynthesisChecks,
} from "./publication";
import { roundFiguresForDisplay } from "./rounding";
import type { RegularContext } from "./evidence/retrieve";
import { FAREWELL } from "./social-patterns";
import { synthesizeWithFallback } from "./synthesis";
import { logStockSage, type StockSageEvent } from "./telemetry";
import type { ChatDataStatus, ChatReply, ChatRequest, Turn } from "./types";

/**
 * The single regular-answer executor: it consumes an already-frozen `Turn`
 * and an already-retrieved `RegularContext` (evidence). It never classifies
 * or routes a turn, evaluates domain policy, or calls a retrieval provider
 * itself; `engine.ts` owns classification and retrieval, and hands both to
 * this module as fixed inputs. See the `unified-engine` step of the
 * `unified-stocksage-engine` plan.
 *
 * The answer order is fixed and always runs, whether or not a synthesis
 * model is configured: deterministic grounded answer when valid, then one
 * primary synthesis attempt, then one configured fallback model, then a
 * deterministic grounded/degraded fallback. A missing model configuration
 * (`hasAnySynthesisLlm` false) simply makes `synthesizeWithFallback` throw
 * immediately, which this executor already treats as "no model available"
 * and answers from the same deterministic ladder — there is no separate
 * code path for the no-model case.
 */

const CLEARLY_ELSEWHERE =
  /\b(?:joke|poem|essay|story|lyrics|weather|recipe|movie|music|celebrity|football|soccer|cricket|basketball|nba|nfl|afl|dating|crush|girlfriend|boyfriend|ask (?:someone|her|him|them) out|homework|python|javascript|typescript|code|script|derive|gravity|physics)\b/i;

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

const SOCIAL_MARKET_CLAIM =
  /\b(?:markets?|stocks?|tech|nasdaq|s&p|dow)\b[^.!?\n]{0,50}\b(?:up|down|red|green|quiet|choppy|volatile|rall(?:y(?:ing)?|ied)|sell(?:ing)?[- ]?off|surg(?:e|ing)|slid(?:e|ing)?|dropp(?:ed|ing)|climb(?:ed|ing)|mov(?:ed|ing)|movement|action)\b|\b(?:quiet|choppy|volatile|busy|wild|red|green|movement|action)\b[^.!?\n]{0,30}\b(?:markets?|stocks?|session|day)\b|\bgood session\b/i;

export type AnswerExecutorArgs = {
  request: ChatRequest;
  /** The frozen classification this executor answers from; never re-derived. */
  turn: Turn;
  /** Already-retrieved evidence; this executor performs no retrieval itself. */
  context: RegularContext;
  startedAt: number;
  budget: RequestBudget;
  /** Wall-clock time `engine.ts` spent retrieving `context`, for telemetry. */
  retrievalMs: number;
  /** Test-only per-request observer for the single executor boundary. */
  onAnswerExecution?: (turn: Turn) => void;
  /**
   * Test-only observation seam, threaded through from `ChatDependencies`:
   * invoked once when this executor enters its synthesis stage (regardless
   * of whether a model is actually configured or the call ultimately
   * succeeds). Production code never sets it. It exists so a test can prove
   * "classifier reject reaches zero synthesis" and "the no-LLM path still
   * runs the same executor stage" without depending on a live model
   * provider, network access, or module-global state that concurrent
   * requests would otherwise share.
   */
  onSynthesisAttempt?: () => void;
};

function dataStatusForContext(
  wantsData: boolean,
  context: RegularContext
): ChatDataStatus {
  const live =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  if (!wantsData) return "full";
  if (!live) return "unavailable";
  return Object.values(context.coverage).some((value) => value === "missing")
    ? "limited"
    : "full";
}

/**
 * The one place every executed turn turns into a published `ChatReply`.
 * The presentation mode is derived deterministically from the frozen
 * turn's decision plus this reply's own `dataStatus` — never hardcoded —
 * so it reflects what was actually published (e.g. a comparison that fell
 * back to partial coverage still reports `limited_evidence`, not
 * `comparison`).
 */
function published(
  turn: Turn,
  reply: ChatReply,
  extra: { presentationReason: string }
): ChatReply {
  return {
    ...reply,
    kind: "answer",
    presentationMode: presentationModeFor(turn.decision, reply.dataStatus ?? "full"),
    presentationReason: extra.presentationReason,
  };
}

export async function executeAnswer(args: AnswerExecutorArgs): Promise<ChatReply> {
  const {
    request,
    turn,
    context,
    startedAt,
    budget,
    retrievalMs,
    onAnswerExecution,
    onSynthesisAttempt,
  } = args;
  onAnswerExecution?.(turn);
  const { decision, context: turnContext } = turn;
  const prefetchEntities =
    turnContext.entities.length > 0
      ? turnContext.entities
      : turnContext.state.entities;
  const resolution = {
    state: turnContext.state,
    entities: turnContext.entities,
    reasonCode: decision.reasonCode,
    temporal: { status: "none" as const, intervals: [] as [] },
  };
  const telemetry = {
    latencyClass: budget.latencyClass,
    decisionKind: decision.kind,
    routeClass: decision.routeClass,
  };

  const wantsData = decision.retrievalAuthorized;
  const social = decision.kind === "social";
  const smuggled = hasSmuggledOffTopicTask(request.message);
  const elsewhere = CLEARLY_ELSEWHERE.test(request.message);
  const offTopicTurn = decision.kind === "out_of_scope";
  const farewellTurn = social && FAREWELL.test(request.message);
  const blendedOffTopic = wantsData && (elsewhere || smuggled);

  const live =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  const dataStatus = dataStatusForContext(wantsData, context);
  const requestedCriteria = wantsData ? detectCriteria(request.message) : [];

  const deterministic = deterministicModelAnswer({
    request,
    prefetchEntities,
    context,
    resolution,
    live,
    dataStatus,
    wantsData,
    requestedCriteria,
    deepEligible: decision.deepEligible,
    blendedOffTopic,
    startedAt,
    retrievalMs,
    telemetry,
  });
  if (deterministic) return published(turn, deterministic, { presentationReason: "deterministic_grounded_answer" });

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
      eligible: decision.deepEligible,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_grounded_answer",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return published(
      turn,
      {
        ...grounded,
        live,
        responseId: deep.responseId,
        deepResearch: deep.offer,
        state: resolution.state,
        dataStatus: grounded.retryable ? "limited" : dataStatus,
      },
      { presentationReason: "deterministic_grounded_answer" }
    );
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
        route: prefetchEntities.length >= 2 ? "comparison" : "current_finance",
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
      eligible: decision.deepEligible,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "source_less_research_floor",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: 0,
    });
    return published(
      turn,
      {
        ...fallback,
        text,
        live,
        responseId: deep.responseId,
        deepResearch: deep.offer,
        state: resolution.state,
        dataStatus: "limited",
      },
      { presentationReason: "source_less_research_floor" }
    );
  }

  if (wantsData && !live) {
    const fallback = buildFallbackReply(
      request,
      {
        route: prefetchEntities.length >= 2 ? "comparison" : "current_finance",
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
      eligible: decision.deepEligible,
    });
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "zero_data_floor",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      ...telemetry,
      providerCount: context.plan.queries.length,
      sourceCount: 0,
    });
    return published(
      turn,
      {
        ...fallback,
        text,
        live: false,
        responseId: deep.responseId,
        deepResearch: deep.offer,
        state: resolution.state,
        dataStatus: "unavailable",
      },
      { presentationReason: "zero_data_floor" }
    );
  }

  const synthesis = synthesizeRegularAnswer({
    request,
    context,
    prefetchEntities,
    entities: turnContext.entities,
    resolution,
    wantsData,
    live,
    requestedCriteria,
    offTopicTurn,
    blendedOffTopic,
    smuggled,
    startedAt,
    retrievalMs,
    dataStatus,
    farewellTurn,
    budget,
    telemetry,
    turn,
    onSynthesisAttempt,
  });
  // Synthesis owns its own timeouts, but lane acquisition, rate-limit waits
  // and retries can still overrun them. This is the outer guarantee: past
  // the deadline we publish the deterministic answer we already hold.
  const finished = await withDeadline<{ reply: ChatReply | null }>(
    synthesis.then((reply) => ({ reply })),
    budget.publishableMs(),
    { reply: null }
  );
  if (finished.reply) {
    return published(turn, finished.reply, {
      presentationReason: finished.reply.presentationReason ?? "single_model_call",
    });
  }
  logStockSage({
    event: "request_complete",
    route: wantsData ? "model_finance" : "model_conversational",
    reasonCode: "deadline_deterministic_fallback",
    durationMs: Date.now() - startedAt,
    retrievalMs,
    ...telemetry,
    deadlineHit: true,
    budgetExceeded: true,
    providerCount: context.plan.queries.length,
    sourceCount: context.sources.length,
  });
  return published(
    turn,
    deadlineFallback({
      request,
      prefetchEntities,
      context,
      resolution,
      live,
      wantsData,
      turn,
    }),
    { presentationReason: "deadline_deterministic_fallback" }
  );
}

/** The best answer available without the model, published on a blown deadline. */
function deadlineFallback(args: {
  request: ChatRequest;
  prefetchEntities: Turn["context"]["entities"];
  context: RegularContext;
  resolution: { state: Turn["context"]["state"]; entities: Turn["context"]["entities"] };
  live: boolean;
  wantsData: boolean;
  turn: Turn;
}): ChatReply {
  if (!args.live) {
    return {
      ...answerDegraded(args.request, Date.now(), args.turn),
      state: args.resolution.state,
      dataStatus: args.wantsData ? "unavailable" : "full",
    };
  }
  const fallback = buildFallbackReply(
    args.request,
    {
      route: args.prefetchEntities.length >= 2 ? "comparison" : "current_finance",
      reasonCode: "deadline_deterministic_fallback",
      retrievalRequired: true,
      deepEligible: false,
    },
    args.prefetchEntities,
    args.context
  );
  return {
    ...fallback,
    text: roundFiguresForDisplay(fallback.text),
    live: true,
    responseId: randomUUID(),
    state: args.resolution.state,
    dataStatus: "limited",
  };
}

type SynthesisArgs = {
  request: ChatRequest;
  context: RegularContext;
  prefetchEntities: Turn["context"]["entities"];
  entities: Turn["context"]["entities"];
  resolution: { state: Turn["context"]["state"]; entities: Turn["context"]["entities"] };
  wantsData: boolean;
  live: boolean;
  requestedCriteria: string[];
  offTopicTurn: boolean;
  blendedOffTopic: boolean;
  smuggled: boolean;
  startedAt: number;
  retrievalMs: number;
  dataStatus: ChatDataStatus;
  farewellTurn: boolean;
  budget: RequestBudget;
  telemetry: Partial<StockSageEvent>;
  turn: Turn;
  onSynthesisAttempt?: () => void;
};

function emptyContext(asOf: string): RegularContext {
  return {
    quotes: [],
    fundamentals: [],
    sources: [],
    coverage: {},
    plan: {
      version: 1,
      depth: "regular",
      route: "general",
      asOf,
      queries: [],
      requiredEntityIds: [],
      criteria: [],
    },
  };
}

/**
 * The one synthesis attempt this executor makes: exactly one Groq primary
 * plus one configured fallback (`synthesis.ts` caps `maxCandidates` at two).
 * Regular chat never requests a correction/repair pass — a rejected
 * candidate simply moves to the next model or falls through to the
 * deterministic fallback below. Deep Research keeps its own single repair
 * pass in `deep.ts`, which this executor does not touch.
 */
async function synthesizeRegularAnswer(
  args: SynthesisArgs
): Promise<ChatReply & { presentationReason?: string }> {
  const {
    request,
    context,
    prefetchEntities,
    entities,
    resolution,
    wantsData,
    live,
    requestedCriteria,
    offTopicTurn,
    blendedOffTopic,
    smuggled,
    startedAt,
    retrievalMs,
    dataStatus,
    farewellTurn,
    budget,
    telemetry,
    turn,
    onSynthesisAttempt,
  } = args;
  const system = buildUnifiedSystemPrompt({
    entities: prefetchEntities,
    quotes: context.quotes,
    fundamentals: context.fundamentals,
    sources: context.sources,
    intervals: context.plan.intervals,
    evidenceGap: context.plan.queries.length > 0 && !live,
  });
  const figureCorpus = [
    system,
    ...request.history
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text),
    request.message,
  ].join("\n");
  const guardFigures = prefetchEntities.length > 0 || live;
  const requireCitations = wantsData && context.sources.length > 0;
  const requireCoverage = wantsData && prefetchEntities.length >= 2;
  const priorReplies = request.history
    .filter((turn) => turn.role === "ai")
    .slice(-3)
    .map((turn) => turn.text);
  const synthesisStartedAt = Date.now();
  const conversational = !wantsData && prefetchEntities.length === 0;
  onSynthesisAttempt?.();
  try {
    let repetitionRejections = 0;
    const text = await synthesizeWithFallback({
      system,
      history: historyMessages(request),
      user: request.message,
      maxTokens: conversational ? 220 : 700,
      temperature: 0.55,
      timeoutMs: budget.publishableMs(),
      totalTimeoutMs: budget.publishableMs(),
      // Regular chat gets no correction/repair pass: exactly one primary
      // model attempt plus (when the first is rejected or unavailable) one
      // configured fallback attempt, never a rewrite of either.
      maxCandidates: 2,
      event: "regular_synthesis",
      lane: conversational ? "light" : "full",
      accept: (candidate) => {
        const rejection = evaluatePublicationCandidate(
          candidate,
          regularSynthesisChecks({
            guardFigures,
            requireCitations,
            requireCoverage,
            wantsData,
            offTopicTurn,
            blendedOffTopic: blendedOffTopic || smuggled,
            farewellTurn,
          }),
          {
            corpus: figureCorpus,
            entities: prefetchEntities,
            quotes: context.quotes,
            sources: context.sources,
            requestedCriteria,
            hasSources: context.sources.length > 0,
            offTopicLeakDetector: leaksOffTopicWork,
            socialMarketClaimPattern: SOCIAL_MARKET_CLAIM,
          }
        );
        if (rejection) return false;
        if (
          repetitionRejections === 0 &&
          repeatedPriorPhrase(candidate, priorReplies, entities) !== null
        ) {
          repetitionRejections += 1;
          return false;
        }
        return true;
      },
    });
    const synthesisMs = Date.now() - synthesisStartedAt;
    const finalized = finalizePublicationText(text, context.sources, {
      stripTickers: true,
      tickers: context.quotes.map((quote) => quote.ticker),
      trim: true,
    });
    const citationUrls = finalized.citationUrls;
    const finalText = finalized.text;
    const deep = wantsData
      ? createDeepResearchOffer({
          question: request.message,
          reply: { text: finalText, live, citationUrls },
          entities: prefetchEntities,
          state: resolution.state,
          sources: context.sources,
          asOf: context.plan.asOf,
          eligible: turn.decision.deepEligible,
        })
      : { responseId: randomUUID() };
    logStockSage({
      event: "request_complete",
      route: wantsData ? "model_finance" : "model_conversational",
      reasonCode: "single_model_call",
      durationMs: Date.now() - startedAt,
      ...telemetry,
      retrievalMs,
      synthesisMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      text: finalText,
      live,
      citationUrls,
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
      presentationReason: "single_model_call",
    };
  } catch {
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
        ...telemetry,
        providerCount: 0,
      });
      return {
        ...concept,
        live: false,
        responseId: randomUUID(),
        state: resolution.state,
        dataStatus: "full",
        presentationReason: "degraded_concept",
      };
    }
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
            eligible: turn.decision.deepEligible,
          })
        : { responseId: randomUUID() };
      logStockSage({
        event: "request_complete",
        route: "model_finance",
        reasonCode: "degraded_from_data",
        durationMs: Date.now() - startedAt,
        ...telemetry,
        retrievalMs,
        providerCount: context.plan.queries.length,
        sourceCount: context.sources.length,
      });
      return {
        ...fallback,
        live,
        responseId: deep.responseId,
        deepResearch: deep.offer,
        state: resolution.state,
        dataStatus: "limited",
        presentationReason: "degraded_from_data",
      };
    }
    return {
      ...answerDegraded(request, startedAt, args.turn),
      dataStatus: wantsData ? "unavailable" : "full",
      presentationReason: "degraded_from_data",
    };
  }
}
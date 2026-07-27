import "server-only";

import { randomUUID } from "node:crypto";
import { budgetFor, withDeadline } from "./budget";
import { answerDegraded } from "./chat-heuristics";
import { createDeepResearchOffer } from "./deep-snapshot";
import { buildGroundedDeterministicReply } from "./grounded-answer";
import { roundFiguresForDisplay } from "./rounding";
import { buildFallbackReply } from "./regular-fallback";
import { detectCriteria } from "./conversation-attributes";
import { hasSmuggledOffTopicTask, creativeRequestOnly } from "./regular-guards";
import {
  resolveConversationState,
  type StateResolution,
} from "./entities";
import { planEvidence } from "./planning";
import { executeEvidencePlan, type RegularContext } from "./retrieve";
import {
  ABUSE_AT_BOT,
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
  FRUSTRATION,
  HELP,
  SOCIAL,
} from "./social-patterns";
import { logStockSage } from "./telemetry";
import type { ChatDependencies, ExecutorOptions } from "./chat-shared";
import { synthesizeModelAnswer } from "./chat-model-synthesis";
import { deterministicModelAnswer } from "./chat-model-deterministic";
import type {
  ChatDataStatus,
  ChatReply,
  ChatRequest,
  Turn,
} from "./types";


const TIME_OR_MARKET =
  /\b(?:latest|today|yesterday|now|current(?:ly)?|recent(?:ly)?|lately|news|update|earnings|guidance|price|trading|move[ds]?|moving|perform(?:s|ed|ing|ance)?|outlook|this (?:week|month|quarter|year)|month[- ]to[- ]date|mtd|trailing month|last (?:few days|week|month|quarter|year)|ytd|year[- ]to[- ]date|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|market|portfolio|nasdaq|nyse|asx|s&p|dow|fed|rates?|inflation|valuation|p\/?e|dividend|risks?|risky|volatil|rank|compare|vs\.?|versus|bigger|safer|cheaper)\b/i;

const CLEARLY_ELSEWHERE =
  /\b(?:joke|poem|essay|story|lyrics|weather|recipe|movie|music|celebrity|football|soccer|cricket|basketball|nba|nfl|afl|dating|crush|girlfriend|boyfriend|ask (?:someone|her|him|them) out|homework|python|javascript|typescript|code|script|derive|gravity|physics)\b/i;

const DATA_SEEKING_FOLLOW_UP =
  /^(?:(?:and|so|then)\s+)?(?:which developments?\b.*\bmatters?|what\b.*\bmatters?|why(?:\s+(?:does|did|is|was|would|could|that|this|it|so))?\b|what are the (?:main|key) catalysts?|which catalyst\b|what should investors? watch\b|summari[sz]e\b.*\b(?:bull|bear|risk|outlook|case))/i;

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

function isPureSocialTurn(message: string): boolean {
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
  presolved?: StateResolution,
  options: ExecutorOptions = {}
): Promise<ChatReply> {
  const turn = options.turn;
  const budget = options.budget ?? budgetFor("regular", startedAt);
  const telemetry = {
    latencyClass: budget.latencyClass,
    ...(turn
      ? {
          decisionKind: turn.decision.kind,
          routeClass: turn.decision.routeClass,
        }
      : {}),
  };
  const resolution = turn
    ? {
        state: turn.context.state,
        entities: turn.context.entities,
        reasonCode: turn.decision.reasonCode,
      }
    : (presolved ??
      resolveConversationState(
        request.message,
        request.state,
        request.history
      ));
  const entities = resolution.entities;
  const social = turn
    ? turn.decision.kind === "social"
    : isPureSocialTurn(request.message);
  const elsewhere = CLEARLY_ELSEWHERE.test(request.message);
  const smuggled = hasSmuggledOffTopicTask(request.message);
  const creativeOnly = creativeRequestOnly(request.message);
  // The frozen decision is the only authority on provider access; the model
  // path may not re-derive it from raw text.
  const wantsData = turn
    ? turn.decision.retrievalAuthorized
    : !social &&
      !creativeOnly &&
      (entities.length > 0 ||
        (resolution.state.entities.length > 0 &&
          DATA_SEEKING_FOLLOW_UP.test(request.message)) ||
        (!elsewhere && TIME_OR_MARKET.test(request.message)));
  const offTopicTurn = turn
    ? turn.decision.kind === "out_of_scope"
    : !social && !wantsData && (elsewhere || smuggled || creativeOnly);
  const farewellTurn = social && FAREWELL.test(request.message);
  const blendedOffTopic = wantsData && (elsewhere || smuggled);

  const prefetchEntities =
    entities.length > 0 ? entities : resolution.state.entities;
  const plan = wantsData
    ? planEvidence({
        route:
          turn?.decision.route === "comparison" ||
          (!turn && prefetchEntities.length >= 2)
            ? "comparison"
            : "current_finance",
        message: request.message,
        entities: prefetchEntities,
        state: resolution.state,
        intervals: turn?.context.intervals,
      })
    : undefined;
  const retrievalStartedAt = Date.now();
  const context = plan
    ? await executeEvidencePlan({
        plan,
        entities: prefetchEntities,
        providers: dependencies.retrievalProviders,
        budget,
      })
    : emptyContext(new Date().toISOString());
  const retrievalMs = Date.now() - retrievalStartedAt;
  const live =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  const dataStatus = dataStatusFor(wantsData, context);
  const requestedCriteria = wantsData ? detectCriteria(request.message) : [];
  const deterministic = deterministicModelAnswer({ request, prefetchEntities, context, resolution, live, dataStatus, wantsData, requestedCriteria, blendedOffTopic, startedAt, retrievalMs, telemetry });
  if (deterministic) return deterministic;

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
      ...telemetry,
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
      ...telemetry,
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
      ...telemetry,
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

  const synthesis = synthesizeModelAnswer({ request, context, plan, prefetchEntities, entities, resolution, wantsData, live, requestedCriteria, offTopicTurn, blendedOffTopic, smuggled, startedAt, retrievalMs, dataStatus, farewellTurn, budget, telemetry, ...(turn ? { turn } : {}) });
  // Synthesis owns its own timeouts, but lane acquisition, rate-limit waits and
  // retries can still overrun them. This is the outer guarantee: past the
  // deadline we publish the deterministic answer we already hold.
  const published = await withDeadline<{ reply: ChatReply | null }>(
    synthesis.then((reply) => ({ reply })),
    // Stop short of the deadline: rendering the fallback still has to fit
    // inside the budget, or the guarantee is off by the cost of keeping it.
    budget.publishableMs(),
    { reply: null }
  );
  if (published.reply) return published.reply;
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
  return deadlineFallback({
    request,
    prefetchEntities,
    context,
    resolution,
    live,
    wantsData,
    dataStatus,
    ...(turn ? { turn } : {}),
  });
}

/** The best answer available without the model, published on a blown deadline. */
function deadlineFallback(args: {
  request: ChatRequest;
  prefetchEntities: StateResolution["entities"];
  context: RegularContext;
  resolution: StateResolution;
  live: boolean;
  wantsData: boolean;
  dataStatus: ChatDataStatus;
  turn?: Turn;
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
      route:
        args.prefetchEntities.length >= 2 ? "comparison" : "current_finance",
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
    kind: "answer",
    responseId: randomUUID(),
    state: args.resolution.state,
    dataStatus: "limited",
  };
}
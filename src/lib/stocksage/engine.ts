import "server-only";

import { executeAnswer } from "./answer";
import { budgetFor, type RequestBudget } from "./budget";
import type { ChatDependencies } from "./chat-shared";
import {
  clarificationChoicesFor,
  immediateResponse,
  presentationModeFor,
  PROHIBITED_FALLBACK,
} from "./chat-shared";
import { crisisResponse, hasDistressSignal } from "./crisis";
import { baseConversationState } from "./entities";
import { normalizeMessage } from "./intent";
import { planEvidence } from "./evidence/planner";
import { executeEvidencePlan, type RegularContext } from "./evidence/retrieve";
import { deepFreeze } from "./immutable";
import { enrichTurnListings } from "./listing-status";
import { decideTurn, isInstantDecision } from "./router";
import {
  beginInputSafetyCheck,
  type SafetyVerdict,
} from "./safety-classifier";
import type { ChatReply, ChatRequest, Turn } from "./types";

function emptyRegularContext(asOf: string): RegularContext {
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
 * The one place the unified engine performs provider I/O for a regular turn.
 * `answer.ts` never retrieves; this reuses the existing retrieval semantics
 * (`evidence/planner.ts` + `evidence/retrieve.ts`) through the shared
 * cache-first evidence path. Also measures the wall-clock time retrieval
 * actually took, so telemetry reflects reality instead of a placeholder.
 */
async function retrieveForTurn(
  turn: Turn,
  request: ChatRequest,
  dependencies: ChatDependencies,
  budget: RequestBudget
): Promise<{ context: RegularContext; retrievalMs: number }> {
  const { decision, context } = turn;
  const retrievalStartedAt = Date.now();
  if (!decision.retrievalAuthorized) {
    return {
      context: emptyRegularContext(new Date().toISOString()),
      retrievalMs: Date.now() - retrievalStartedAt,
    };
  }
  const prefetchEntities =
    context.entities.length > 0 ? context.entities : context.state.entities;
  const plan = planEvidence({
    route: decision.route === "comparison" ? "comparison" : "current_finance",
    message: request.message,
    entities: prefetchEntities,
    state: context.state,
    intervals: context.intervals,
  });
  const evidence = await executeEvidencePlan({
    plan,
    entities: prefetchEntities,
    providers: dependencies.retrievalProviders,
    budget,
  });
  return { context: evidence, retrievalMs: Date.now() - retrievalStartedAt };
}

/**
 * Crisis and prohibited-content refusals fall outside the finance-answer
 * presentation surface (see `presentationModeFor`), so they intentionally
 * leave `presentationMode` unset — the widget already renders these from
 * `route`/`text` alone.
 */
function refusalReply(
  verdict: Extract<SafetyVerdict, { action: "crisis" | "refuse" }>,
  base: ReturnType<typeof baseConversationState>,
  startedAt: number
): ChatReply {
  return immediateResponse({
    text:
      verdict.action === "crisis"
        ? crisisResponse(verdict.kind)
        : PROHIBITED_FALLBACK,
    state: base,
    route: verdict.action === "crisis" ? "safety_support" : "refused",
    reasonCode:
      verdict.action === "crisis"
        ? "classifier_self_harm_language"
        : "classifier_prohibited_content",
    startedAt,
  });
}

/**
 * The unified regular engine: one gate, one `decideTurn`, retrieval that
 * starts alongside the safety classifier, one answer executor (`answer.ts`),
 * and one publication step (`immediateResponse` for instant turns, the
 * executor's own return for every other turn). Crisis and hard-policy turns
 * never reach retrieval, the answer executor, or a model — `decideTurn`
 * already marks them `retrievalAuthorized: false` and (for crisis/hard-policy
 * specifically) `safetyRailRequired: false`.
 *
 * The safety verdict is awaited before any synthesis or publication runs:
 * it only overlaps retrieval, never model work, so a classifier verdict
 * that arrives unsafe can never be raced by an already-published reply.
 */
export async function runUnifiedEngine(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const normalized = normalizeMessage(request.message);
  const scoped: ChatRequest = { ...request, message: normalized };
  const base = baseConversationState(request.state, request.history);

  let turn = decideTurn(scoped);
  // The router already freezes normal decisions and contexts. Deep-freeze
  // both here as a final guard (including the one high-stakes context branch
  // assembled with object spreads), so nested collections — entities,
  // groups, intervals, `state` itself — can't be mutated in place either.
  // Safe because every array/object reachable from `turn` is data this
  // engine built fresh (see `sanitizeConversationState`/`resolveTurnContext`);
  // `request`/`request.history`, which the caller owns, are never part of it.
  const finalizeTurn = (candidate: Turn): Turn => {
    deepFreeze(candidate.decision);
    deepFreeze(candidate.context);
    Object.freeze(candidate);
    dependencies.onTurnFinalized?.(candidate);
    return candidate;
  };
  const { decision, context } = turn;

  // Crisis and the hard safety floor are themselves the safe output: zero
  // retrieval, zero model, zero classifier round trip.
  if (!decision.safetyRailRequired && decision.immediateText !== undefined) {
    finalizeTurn(turn);
    const dataStatus =
      decision.reasonCode === "australian_listing_clarified"
        ? ("limited" as const)
        : ("full" as const);
    return immediateResponse({
      text: decision.immediateText,
      state: context.state,
      route: decision.route,
      reasonCode: decision.reasonCode,
      startedAt,
      decision,
      presentationMode: presentationModeFor(decision, dataStatus),
      dataStatus,
    });
  }

  const safetyInput = [
    ...(hasDistressSignal(normalized)
      ? request.history
          .filter((historyTurn) => historyTurn.role === "user")
          .slice(-3)
          .map((historyTurn) => historyTurn.text)
      : []),
    normalized,
  ]
    .join("\n")
    .slice(-2_000);

  if (isInstantDecision(decision)) {
    finalizeTurn(turn);
    // Safety and refusal copy is already the safe answer. Every other
    // instant reply still has to clear the classifier before it is
    // published, and a plain greeting only pays for the rail when it
    // carries distress language.
    const needsRail =
      decision.safetyRailRequired &&
      (decision.kind !== "social" || hasDistressSignal(normalized));
    if (needsRail) {
      const verdict = await beginInputSafetyCheck(
        safetyInput,
        dependencies.safetyClassifier
      );
      if (verdict.action !== "allow") return refusalReply(verdict, base, startedAt);
    }
    const dataStatus =
      decision.reasonCode === "australian_listing_clarified"
        ? ("limited" as const)
        : ("full" as const);
    return immediateResponse({
      text: decision.immediateText as string,
      state: context.state,
      route: decision.route,
      reasonCode: decision.reasonCode,
      startedAt,
      decision,
      presentationMode: presentationModeFor(decision, dataStatus),
      dataStatus,
      // Real, finite-option clarifications (see `clarificationChoicesFor`)
      // get actionable chips. Every other clarification — missing
      // companies, stale former/latter, and other open-ended prompts —
      // gets none: resubmitting the clarifying question itself is not a
      // choice, so the widget falls back to free text instead.
      ...(decision.clarification
        ? {
            clarificationChoices: clarificationChoicesFor(decision.reasonCode),
          }
        : {}),
    });
  }

  // Started, not awaited: retrieval overlaps the classifier instead of
  // adding a round trip in front of it. The unified engine still awaits the
  // verdict below before any synthesis or publication happens.
  const safety = beginInputSafetyCheck(safetyInput, dependencies.safetyClassifier);
  turn = finalizeTurn(await enrichTurnListings(turn));
  const budget = budgetFor("regular", startedAt);
  const { context: evidence, retrievalMs } = await retrieveForTurn(
    turn,
    scoped,
    dependencies,
    budget
  );
  dependencies.onRetrievalComplete?.(retrievalMs);

  const verdict = await safety;
  if (verdict.action !== "allow") return refusalReply(verdict, base, startedAt);

  return executeAnswer({
    request: scoped,
    turn,
    context: evidence,
    startedAt,
    budget,
    retrievalMs,
    onAnswerExecution: dependencies.onAnswerExecution,
    onSynthesisAttempt: dependencies.onSynthesisAttempt,
  });
}

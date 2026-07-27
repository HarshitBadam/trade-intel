import "server-only";

import { hasAnySynthesisLlm } from "@/lib/config";
import { budgetFor } from "./budget";
import { baseConversationState } from "./entities";
import { crisisResponse, hasDistressSignal } from "./crisis";
import { normalizeMessage } from "./intent";
import { answerWithHeuristics } from "./chat-heuristics";
import { answerWithModel } from "./chat-model";
import {
  immediateResponse,
  PROHIBITED_FALLBACK,
  type ChatDependencies,
} from "./chat-shared";
import { beginInputSafetyCheck } from "./safety-classifier";
import { logStockSage } from "./telemetry";
import { decideTurn, turnDecisionMode } from "./turn-decision";
import type { ChatReply, ChatRequest, Turn } from "./types";

function shadowLog(turn: Turn): void {
  logStockSage({
    event: "turn_decision_shadow",
    decisionKind: turn.decision.kind,
    route: turn.decision.route,
    routeClass: turn.decision.routeClass,
    latencyClass: turn.decision.latencyClass,
    reasonCode: turn.decision.reasonCode,
    entities: turn.context.entities.map((entity) => entity.id),
    deepEligible: turn.decision.deepEligible,
    retryVisible: turn.decision.retryEligible,
  });
}

export async function answerChat(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const normalized = normalizeMessage(request.message);
  const scoped: ChatRequest = { ...request, message: normalized };
  const base = baseConversationState(request.state, request.history);

  const turn = turnDecisionMode === "off" ? null : decideTurn(scoped);
  if (turn && turnDecisionMode === "shadow") shadowLog(turn);
  const authoritative = turn && turnDecisionMode === "on" ? turn : null;

  // A distressed message must never reach the market path just because it
  // happens to contain ticker-shaped words.
  const crisisText =
    authoritative &&
    (authoritative.decision.reasonCode === "explicit_self_harm_language" ||
      authoritative.decision.reasonCode === "acute_distress_language")
      ? authoritative.decision.immediateText
      : undefined;
  if (authoritative && crisisText !== undefined) {
    return immediateResponse({
      text: crisisText,
      state: base,
      route: "safety_support",
      reasonCode: authoritative.decision.reasonCode,
      startedAt,
      decision: authoritative.decision,
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

  const immediateText = authoritative?.decision.immediateText;
  if (authoritative && immediateText !== undefined) {
    const { decision, context } = authoritative;
    // Safety and refusal copy is already the safe answer. Every other instant
    // reply still has to clear the classifier before it is published, and a
    // plain greeting only pays for the rail when it carries distress language.
    const needsRail =
      decision.safetyRailRequired &&
      (decision.kind !== "social" || hasDistressSignal(normalized));
    if (needsRail) {
      const verdict = await beginInputSafetyCheck(
        safetyInput,
        dependencies.safetyClassifier
      );
      if (verdict.action !== "allow") {
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
    }
    return immediateResponse({
      text: immediateText,
      state: context.state,
      route: decision.route,
      reasonCode: decision.reasonCode,
      startedAt,
      decision,
      ...(decision.reasonCode === "australian_listing_clarified"
        ? { dataStatus: "limited" as const }
        : {}),
    });
  }

  // Started, not awaited: the verdict is joined after synthesis so the
  // classifier overlaps retrieval instead of adding a round trip in front of it.
  const safety = beginInputSafetyCheck(safetyInput, dependencies.safetyClassifier);
  const budget = budgetFor("regular", startedAt);
  const reply = hasAnySynthesisLlm
    ? await answerWithModel(scoped, dependencies, startedAt, undefined, {
        turn: authoritative ?? undefined,
        budget,
      })
    : await answerWithHeuristics(scoped, dependencies, startedAt, {
        turn: authoritative ?? undefined,
        budget,
      });
  const verdict = await safety;
  if (verdict.action === "allow") return reply;
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

export type { ChatDependencies } from "./chat-shared";

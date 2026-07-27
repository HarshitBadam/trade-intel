import "server-only";

import { hasAnySynthesisLlm } from "@/lib/config";
import {
  baseConversationState,
  resolveConversationState,
} from "./entities";
import {
  crisisResponse,
  detectCrisis,
  hasDistressSignal,
} from "./crisis";
import {
  immediateReply,
  normalizeMessage,
  routeMessage,
} from "./intent";
import { answerWithHeuristics } from "./chat-heuristics";
import { answerWithModel } from "./chat-model";
import {
  immediateResponse,
  PROHIBITED_FALLBACK,
  type ChatDependencies,
} from "./chat-shared";
import { beginInputSafetyCheck } from "./safety-classifier";
import {
  classifyHighStakes,
  evaluateDomainPolicy,
  hardSafetyFloor,
  pickHighStakesReply,
} from "./policy";
import { creativeRequestOnly } from "./regular-guards";
import type { ChatReply, ChatRequest, FinanceEntity } from "./types";

function australianListingClarification(
  message: string,
  entities: FinanceEntity[]
): string | null {
  const entity = entities.find(
    (candidate) =>
      candidate.market === "au" || candidate.jurisdiction === "Australia"
  );
  if (
    !entity ||
    !/\b(?:australia|australian|aussie|asx|home listing|primary listing|underlying listing)\b/i.test(
      message
    ) ||
    !/\b(?:actually|i mean|not|is aussie|is australian|it'?s aussie|it is australian|home listing|primary listing|underlying listing)\b/i.test(
      message
    )
  ) {
    return null;
  }
  const listing = entity.ticker ? `ASX:${entity.ticker}` : "its ASX listing";
  return `Yes — ${entity.name} is Australian and its primary listing is ${listing}. The displayed market figure is for the clearly labelled U.S. ADR; ADR and ASX returns can differ, so each instrument stays explicitly identified. Business and reporting analysis remains anchored to ${entity.name}.`;
}

export async function answerChat(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const normalized = normalizeMessage(request.message);
  const scoped: ChatRequest = { ...request, message: normalized };

  // Runs before entity resolution: a distressed message must never reach the
  // market path just because it happens to contain ticker-shaped words.
  const crisis = detectCrisis(normalized);
  if (crisis) {
    return immediateResponse({
      text: crisisResponse(crisis),
      state: baseConversationState(request.state, request.history),
      route: "safety_support",
      reasonCode:
        crisis === "self_harm"
          ? "explicit_self_harm_language"
          : "acute_distress_language",
      startedAt,
    });
  }

  const base = baseConversationState(request.state, request.history);
  // Resolve entities before policy so safety checks see newly named subjects.
  const initialResolution = resolveConversationState(
    normalized,
    request.state,
    request.history
  );
  const policyEntities =
    initialResolution.entities.length > 0
      ? initialResolution.entities
      : initialResolution.state.entities.length > 0
        ? initialResolution.state.entities
        : base.entities;
  const floor = hardSafetyFloor(normalized, policyEntities);
  if (floor?.response) {
    const resolved = initialResolution;
    const highStakes =
      floor.reasonCode === "high_stakes_finance"
        ? classifyHighStakes(normalized, policyEntities)
        : null;
    const picked = highStakes
      ? pickHighStakesReply(
          highStakes,
          resolved.state.safetyRepliesUsed ?? []
        )
      : null;
    const state = picked
      ? {
          ...resolved.state,
          safetyRepliesUsed: [
            ...(resolved.state.safetyRepliesUsed ?? []),
            picked.id,
          ].slice(-24),
        }
      : resolved.state;
    return immediateResponse({
      text: picked?.text ?? floor.response,
      state,
      route:
        floor.reasonCode === "explicit_self_harm" ||
        floor.reasonCode === "acute_distress" ||
        floor.reasonCode === "threat_of_violence"
          ? "safety_support"
          : "refused",
      reasonCode: floor.reasonCode,
      startedAt,
    });
  }

  const listingClarification = australianListingClarification(
    normalized,
    policyEntities
  );
  if (listingClarification) {
    return immediateResponse({
      text: listingClarification,
      state: initialResolution.state,
      route: "current_finance",
      reasonCode: "australian_listing_clarified",
      startedAt,
      dataStatus: "limited",
    });
  }

  const socialResolution = initialResolution;
  if (creativeRequestOnly(normalized)) {
    const policy = evaluateDomainPolicy(normalized, []);
    return immediateResponse({
      text:
        policy.response ??
        "I stick to financial markets and company research, so I can’t write the creative piece.",
      state: socialResolution.state,
      route: "out_of_scope",
      reasonCode: "out_of_scope",
      startedAt,
    });
  }
  const socialDecision = routeMessage({
    message: normalized,
    entities: socialResolution.entities,
    state: socialResolution.state,
    clarification: socialResolution.clarification,
  });
  // History is useful for an ambiguous "please help me" after a distress
  // disclosure, but sending it with every later finance question can keep a
  // recovered user stuck in the safety route.
  const safetyInput = [
    ...(hasDistressSignal(normalized)
      ? request.history
          .filter((turn) => turn.role === "user")
          .slice(-3)
          .map((turn) => turn.text)
      : []),
    normalized,
  ]
    .join("\n")
    .slice(-2_000);
  const safetyCheck = hasDistressSignal(normalized)
    ? beginInputSafetyCheck(safetyInput, dependencies.safetyClassifier)
    : null;
  // The router already decides a turn is social from these same patterns, so a
  // second gate here only made conversational turns pay for a model round trip.
  if (socialDecision.route === "social") {
    const text = immediateReply(socialDecision, normalized);
    if (text) {
      const verdict = safetyCheck ? await safetyCheck : { action: "allow" as const };
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
      return immediateResponse({
        text,
        state: socialResolution.state,
        route: "social",
        reasonCode: socialDecision.reasonCode,
        startedAt,
      });
    }
  }

  // Started, not awaited: the verdict is joined after synthesis so the
  // classifier overlaps retrieval instead of adding a round trip in front of it.
  const safety =
    safetyCheck ??
    beginInputSafetyCheck(safetyInput, dependencies.safetyClassifier);
  const reply = hasAnySynthesisLlm
    ? await answerWithModel(scoped, dependencies, startedAt, initialResolution)
    : await answerWithHeuristics(scoped, dependencies, startedAt);
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
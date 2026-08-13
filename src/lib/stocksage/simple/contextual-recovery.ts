import { randomUUID } from "node:crypto";
import { llmErrorSummary } from "@/lib/llm";
import type { StateResolution } from "../conversation";
import type { ChatReply, ChatRequest, ConversationState } from "../types";
import type {
  ContextualRecoveryHints,
  ContextualRecoveryResult,
  SimpleEvidencePlan,
  SimpleRuntimeDependencies,
} from "./contracts";
import { recoverContextualEvidencePlan } from "./extraction";
import {
  simpleClarificationReply,
  simpleOutOfScopeReply,
  simpleSocialReply,
} from "./responses";
import { hasSimpleEvidenceRequest } from "./validation";

type ClarificationFallback = {
  text: string;
  reason: string;
};

type ContextualRecoveryOptions = {
  clarification?: ClarificationFallback;
  hints?: ContextualRecoveryHints;
};

export type ContextualRecoveryOutcome = {
  attempted: boolean;
  plan?: SimpleEvidencePlan;
  reply?: ChatReply;
};

const STRONG_ENTITY_REASONS = new Set([
  "entity_correction",
  "canonical_group_expanded",
  "ordered_reference_resolved",
  "anchored_reference_resolved",
  "conversation_reference_resolved",
  "explicit_entities",
]);

export function contextualRecoveryHints(
  resolution: StateResolution
): ContextualRecoveryHints {
  return {
    resolvedCurrentEntities: STRONG_ENTITY_REASONS.has(resolution.reasonCode)
      ? resolution.entities
      : [],
  };
}

function nonResearchReply(
  state: ConversationState,
  message: string,
  disposition: Exclude<ContextualRecoveryResult["disposition"], "research">,
  clarification?: ClarificationFallback
): ChatReply {
  if (disposition === "social") {
    return {
      text: simpleSocialReply(message),
      live: false,
      kind: "answer",
      responseId: randomUUID(),
      state,
      dataStatus: "full",
      presentationMode: "social",
      presentationReason: "contextual_social",
    };
  }
  if (disposition === "acknowledgement") {
    return {
      text: "No worries. Let me know if you want to look at anything else.",
      live: false,
      kind: "answer",
      responseId: randomUUID(),
      state,
      dataStatus: "full",
      presentationMode: "social",
      presentationReason: "contextual_acknowledgement",
    };
  }
  if (disposition === "out_of_scope") {
    return simpleOutOfScopeReply(state, "contextual_out_of_scope");
  }
  return simpleClarificationReply(
    state,
    clarification?.text ??
      "Sorry, I didn’t quite catch that. What would you like to look at next?",
    clarification?.reason ?? "contextual_follow_up_ambiguous"
  );
}

export async function resolveContextualRecovery(
  request: ChatRequest,
  state: ConversationState,
  dependencies: SimpleRuntimeDependencies,
  options: ContextualRecoveryOptions = {}
): Promise<ContextualRecoveryOutcome> {
  const hints = options.hints ?? { resolvedCurrentEntities: [] };
  const recover = dependencies.recoverContextualTurn
    ? dependencies.recoverContextualTurn
    : dependencies.extractPlan
      ? undefined
      : (candidate: ChatRequest) =>
          recoverContextualEvidencePlan(
            candidate,
            dependencies.now,
            undefined,
            hints
          );
  if (!recover) return { attempted: false };

  let recovery: ContextualRecoveryResult;
  try {
    recovery = await recover(request, hints);
  } catch (error) {
    console.warn(
      "[stocksage]",
      JSON.stringify({
        event: "simple_contextual_recovery_failed",
        ...llmErrorSummary(error),
      })
    );
    return { attempted: true };
  }

  if (
    recovery.disposition === "research" &&
    hasSimpleEvidenceRequest(recovery.plan)
  ) {
    return { attempted: true, plan: recovery.plan };
  }
  const disposition =
    recovery.disposition === "research" ||
    (recovery.disposition === "out_of_scope" &&
      hints.resolvedCurrentEntities.length > 0)
      ? "ambiguous"
      : recovery.disposition;
  return {
    attempted: true,
    reply: nonResearchReply(
      state,
      request.message,
      disposition,
      options.clarification
    ),
  };
}

import "server-only";

import { randomUUID } from "node:crypto";
import { isOpen } from "@/lib/breaker";
import { createDeepResearchOffer } from "./deep-snapshot";
import { resolveConversationState } from "./entities";
import { immediateReply, normalizeMessage, routeMessage } from "./intent";
import { planEvidence } from "./planning";
import { evaluateDomainPolicy } from "./policy";
import { answerRegularChat } from "./regular";
import {
  executeEvidencePlan,
  type RetrievalProviders,
} from "./retrieve";
import { logStockSage } from "./telemetry";
import type { ChatReply, ChatRequest } from "./types";

export type ChatDependencies = {
  retrievalProviders?: RetrievalProviders;
};

function immediateResponse(args: {
  text: string;
  state: ReturnType<typeof resolveConversationState>["state"];
  route: string;
  reasonCode: string;
  startedAt: number;
}): ChatReply {
  logStockSage({
    event: "request_complete",
    route: args.route,
    reasonCode: args.reasonCode,
    durationMs: Date.now() - args.startedAt,
    providerCount: 0,
  });
  return {
    text: args.text,
    live: false,
    responseId: randomUUID(),
    state: args.state,
  };
}

export async function answerChat(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const startedAt = Date.now();
  const normalized = normalizeMessage(request.message);
  const resolution = resolveConversationState(
    normalized,
    request.state,
    request.history
  );
  const policy = evaluateDomainPolicy(
    normalized,
    resolution.entities
  );
  if (policy.action !== "allow") {
    return immediateResponse({
      text: policy.response ?? "Please ask a financial-market question.",
      state: resolution.state,
      route:
        policy.action === "clarify"
          ? "clarify"
          : policy.reasonCode === "out_of_scope"
            ? "out_of_scope"
            : "refused",
      reasonCode: policy.reasonCode,
      startedAt,
    });
  }
  const decision = routeMessage({
    message: normalized,
    entities: resolution.entities,
    state: resolution.state,
    clarification: resolution.clarification,
  });
  const immediate = immediateReply(decision, normalized);
  if (immediate) {
    return immediateResponse({
      text: immediate,
      state: resolution.state,
      route: decision.route,
      reasonCode: decision.reasonCode,
      startedAt,
    });
  }

  const plan = planEvidence({
    route: decision.route,
    message: normalized,
    entities: resolution.entities,
    state: resolution.state,
  });
  const retrievalStartedAt = Date.now();
  const context = await executeEvidencePlan({
    plan,
    entities: resolution.entities,
    providers: dependencies.retrievalProviders,
  });
  const retrievalMs = Date.now() - retrievalStartedAt;
  const synthesisStartedAt = Date.now();
  const reply = await answerRegularChat(
    { ...request, message: normalized },
    decision,
    resolution.entities,
    resolution.state,
    context
  );
  const synthesisMs = Date.now() - synthesisStartedAt;
  const deepEligible =
    decision.deepEligible &&
    reply.live &&
    !(await isOpen("langflow-deep"));
  const deep = deepEligible
    ? createDeepResearchOffer({
        question: normalized,
        reply,
        entities: resolution.entities,
        state: resolution.state,
        sources: context.sources,
        asOf: plan.asOf,
      })
    : { responseId: randomUUID() };
  logStockSage({
    event: "request_complete",
    route: decision.route,
    reasonCode: decision.reasonCode,
    durationMs: Date.now() - startedAt,
    retrievalMs,
    synthesisMs,
    providerCount: plan.queries.length,
    sourceCount: context.sources.length,
  });
  return {
    ...reply,
    responseId: deep.responseId,
    deepResearch: deep.offer,
    state: resolution.state,
  };
}

export type {
  ChatReply,
  ChatRequest,
  ChatTurn,
} from "./types";

import "server-only";

import { randomUUID } from "node:crypto";
import type { RetrievalProviders } from "./retrieve";
import { logStockSage } from "./telemetry";
import type { ChatReply, ConversationState } from "./types";

export type ChatDependencies = {
  retrievalProviders?: RetrievalProviders;
};

export const SELF_HARM_RESPONSE =
  "I’m sorry you’re dealing with this. If you may act on thoughts of harming yourself, call local emergency services now. In Australia, Lifeline is available at 13 11 14; elsewhere, contact your local crisis line or emergency number. If you can, tell someone you trust and stay with them.";

export const PROHIBITED_FALLBACK =
  "I can’t help with that. I can help analyze markets, listed companies, and investment risk.";

export function immediateResponse(args: {
  text: string;
  state: ConversationState;
  route: string;
  reasonCode: string;
  startedAt: number;
  retryable?: boolean;
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
    kind: "answer",
    responseId: randomUUID(),
    state: args.state,
    ...(args.retryable !== undefined ? { retryable: args.retryable } : {}),
  };
}

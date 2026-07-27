import "server-only";

import { randomUUID } from "node:crypto";
import type { RetrievalProviders } from "./retrieve";
import type { SafetyClassifier } from "./safety-classifier";
import { logStockSage } from "./telemetry";
import type {
  ChatDataStatus,
  ChatReply,
  ConversationState,
} from "./types";

export type ChatDependencies = {
  retrievalProviders?: RetrievalProviders;
  safetyClassifier?: SafetyClassifier;
};

export {
  ACUTE_DISTRESS_RESPONSE,
  SELF_HARM_RESPONSE,
} from "./crisis";

export const PROHIBITED_FALLBACK =
  "I can’t help with that. I can help analyze markets, listed companies, and investment risk.";

export function immediateResponse(args: {
  text: string;
  state: ConversationState;
  route: string;
  reasonCode: string;
  startedAt: number;
  retryable?: boolean;
  dataStatus?: ChatDataStatus;
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
    dataStatus: args.dataStatus ?? "full",
    ...(args.retryable !== undefined ? { retryable: args.retryable } : {}),
  };
}

"use server";

import { guard } from "@/lib/guard";
import { answerChat } from "@/lib/stocksage/chat";
import { runDeepResearch } from "@/lib/stocksage/deep";
import { logStockSage } from "@/lib/stocksage/telemetry";
import { parseChatRequest } from "@/lib/stocksage/types";
import type {
  ChatReply,
  DeepResearchReply,
} from "@/lib/stocksage/types";

export type {
  ChatReply,
  ChatRequest,
  ChatTurn,
  DeepResearchReply,
} from "@/lib/stocksage/types";

export async function getSummary(request: unknown): Promise<ChatReply> {
  const startedAt = Date.now();
  const parsed = parseChatRequest(request);
  if (!parsed.ok) {
    return {
      text: parsed.error,
      live: false,
      kind: "error",
      errorCode: "invalid_request",
    };
  }
  const guardStartedAt = Date.now();
  const access = await guard("chat", { limit: 24, windowSec: 60 });
  const guardMs = Date.now() - guardStartedAt;
  if (!access.ok) {
    if (access.reason === "unauthorized") {
      return {
        text: "Please sign in to continue your StockSage conversation.",
        live: false,
        kind: "error",
        errorCode: "unauthorized",
        state: parsed.value.state,
      };
    }
    return {
      text: `Let’s pause for ${access.retryAfterSec}s, then you can continue from the same conversation.`,
      live: false,
      kind: "error",
      errorCode: "rate_limited",
      retryable: true,
      state: parsed.value.state,
    };
  }

  const reply = await answerChat(parsed.value);
  logStockSage({
    event: "server_action_complete",
    durationMs: Date.now() - startedAt,
    guardMs,
  });
  return reply;
}

export async function researchDeeper(
  token: unknown
): Promise<DeepResearchReply> {
  const startedAt = Date.now();
  const guardStartedAt = Date.now();
  const access = await guard("deep-research", { limit: 4, windowSec: 60 });
  const guardMs = Date.now() - guardStartedAt;
  if (!access.ok) {
    return {
      workId: "unavailable",
      status: "failure",
      text:
        access.reason === "unauthorized"
          ? "Please sign in to use Research deeper."
          : `Research requests are limited right now. Try again in ${access.retryAfterSec}s.`,
      retryable: access.reason !== "unauthorized",
    };
  }
  const reply = await runDeepResearch(token);
  logStockSage({
    event: "deep_server_action_complete",
    durationMs: Date.now() - startedAt,
    guardMs,
  });
  return reply;
}

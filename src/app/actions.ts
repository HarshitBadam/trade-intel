"use server";

import { guard } from "@/lib/resilience/guard";
import { answerChat } from "@/lib/stocksage/chat";
import { logStockSage } from "@/lib/telemetry";
import { parseChatRequest } from "@/lib/stocksage/types";
import type { ChatReply } from "@/lib/stocksage/types";

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

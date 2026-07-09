"use server";

import { guard } from "@/lib/guard";
import { answerChat, warmStockSage as warmStockSageCore } from "@/lib/stocksage/chat";
import type { ChatReply, ChatTurn } from "@/lib/stocksage/chat";

// Thin "use server" surface for the chat widget. All chat logic (grounding,
// Langflow-first transport, Groq fallback, breaker bookkeeping) lives in the
// testable core at lib/stocksage/chat.ts; this file only enforces auth + rate
// limiting and forwards to it.

export type { ChatReply, ChatTurn };

export async function warmStockSage(): Promise<void> {
  await warmStockSageCore();
}

export async function getSummary(
  message: string,
  sessionId?: string,
  history: ChatTurn[] = []
): Promise<ChatReply> {
  const access = await guard("chat", { limit: 10, windowSec: 60 });
  if (!access.ok) {
    if (access.reason === "unauthorized") {
      return { text: "Please sign in to chat with StockSage.", live: false };
    }
    return {
      text: `You're sending messages too quickly. Try again in ${access.retryAfterSec}s.`,
      live: false,
    };
  }

  return answerChat(message, sessionId, history);
}

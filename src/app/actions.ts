"use server";

import { guard } from "@/lib/guard";
import { answerChat } from "@/lib/stocksage/chat";
import { parseChatRequest } from "@/lib/stocksage/types";
import type { ChatReply } from "@/lib/stocksage/types";

export type { ChatMode, ChatReply, ChatRequest, ChatTurn } from "@/lib/stocksage/types";

export async function getSummary(request: unknown): Promise<ChatReply> {
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

  const parsed = parseChatRequest(request);
  if (!parsed.ok) return { text: parsed.error, live: false };
  return answerChat(parsed.value);
}

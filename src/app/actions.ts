"use server";

import { guard } from "@/lib/guard";
import { answerChat } from "@/lib/stocksage/chat";
import { runDeepResearch } from "@/lib/stocksage/deep";
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

export async function researchDeeper(
  token: unknown
): Promise<DeepResearchReply> {
  const access = await guard("deep-research", { limit: 4, windowSec: 60 });
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
  return runDeepResearch(token);
}

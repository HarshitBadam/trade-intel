"use server";

import { guard } from "@/lib/guard";
import { answerChat } from "@/lib/stocksage/chat";
import {
  enqueueDeepResearch,
  pollDeepResearch,
  type DeepResearchJob,
} from "@/lib/stocksage/deep-queue";
import { logStockSage } from "@/lib/stocksage/telemetry";
import { parseChatRequest } from "@/lib/stocksage/types";
import type { ChatReply } from "@/lib/stocksage/types";

export type { DeepResearchJob } from "@/lib/stocksage/deep-queue";
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

function deniedJob(access: {
  reason?: string;
  retryAfterSec?: number;
}): DeepResearchJob {
  return {
    status: "failure",
    reply: {
      workId: "unavailable",
      status: "failure",
      text:
        access.reason === "unauthorized"
          ? "Please sign in to use Research deeper."
          : `Research requests are limited right now. Try again in ${access.retryAfterSec}s.`,
      retryable: access.reason !== "unauthorized",
    },
  };
}

export async function researchDeeper(
  token: unknown
): Promise<DeepResearchJob> {
  const startedAt = Date.now();
  const guardStartedAt = Date.now();
  const access = await guard("deep-research", { limit: 4, windowSec: 60 });
  const guardMs = Date.now() - guardStartedAt;
  if (!access.ok) return deniedJob(access);
  const job = await enqueueDeepResearch(token);
  logStockSage({
    event: "deep_server_action_complete",
    durationMs: Date.now() - startedAt,
    guardMs,
    reasonCode: job.status,
  });
  return job;
}

/** Polling companion to `researchDeeper`; cheap enough for a 2s interval. */
export async function checkDeepResearch(
  workId: unknown
): Promise<DeepResearchJob> {
  if (typeof workId !== "string" || workId.length === 0) {
    return {
      status: "failure",
      reply: {
        workId: "invalid",
        status: "failure",
        text: "Open Research deeper from the latest StockSage answer.",
      },
    };
  }
  // Polling shares the deep-research bucket but with a far higher ceiling; it
  // starts no work, and a blocked poll would strand a job the user paid for.
  const access = await guard("deep-poll", { limit: 120, windowSec: 60 });
  if (!access.ok) return deniedJob(access);
  return pollDeepResearch(workId);
}

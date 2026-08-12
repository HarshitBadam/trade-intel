import "server-only";

import { createHash } from "node:crypto";
import {
  STOCKSAGE_ENGINE,
  STOCKSAGE_GREENFIELD_CANARY_PERCENT,
} from "@/lib/config";
import { runUnifiedEngine } from "./engine";
import type { ChatDependencies } from "./chat-shared";
import { runGreenfieldChatAdapter } from "./greenfield/chat-adapter";
import { runSimpleChatAdapter } from "./simple-runtime";
import type { ChatReply, ChatRequest } from "./types";

export type StockSageEngine = "legacy" | "greenfield" | "simple";

/**
 * A session maps to one of 10,000 stable buckets. Requests without a session
 * never enter the percentage canary because they cannot be kept sticky.
 */
export function isGreenfieldCanarySession(
  sessionId: string | undefined,
  percentage = STOCKSAGE_GREENFIELD_CANARY_PERCENT
): boolean {
  if (!sessionId || !Number.isFinite(percentage) || percentage <= 0) return false;
  if (percentage >= 100) return true;
  const bucket = createHash("sha256")
    .update(`stocksage-greenfield-v1:${sessionId}`)
    .digest()
    .readUInt32BE(0) % 10_000;
  return bucket < Math.floor(percentage * 100);
}

/**
 * State v2 is the strongest selector: once emitted it can never cross back
 * into the legacy engine. The per-request dependency override is otherwise
 * authoritative so tests and benchmarks do not depend on process env.
 */
export function selectStockSageEngine(
  request: ChatRequest,
  dependencies: Pick<ChatDependencies, "engine"> = {}
): StockSageEngine {
  if (request.state?.version === 2) return "greenfield";
  if (dependencies.engine) return dependencies.engine;
  if (STOCKSAGE_ENGINE === "simple") return "simple";
  if (STOCKSAGE_ENGINE === "greenfield") return "greenfield";
  return isGreenfieldCanarySession(request.sessionId) ? "greenfield" : "legacy";
}

function runLegacyChat(
  request: ChatRequest,
  dependencies: ChatDependencies
): Promise<ChatReply> {
  return runUnifiedEngine(request, dependencies);
}

/** Stable public wrapper; legacy remains the default rollout path. */
export async function answerChat(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  const engine = selectStockSageEngine(request, dependencies);
  if (engine === "simple") {
    return runSimpleChatAdapter(request, dependencies.simple);
  }
  if (engine === "greenfield") {
    return runGreenfieldChatAdapter(request, dependencies);
  }
  return runLegacyChat(request, dependencies);
}

export type { ChatDependencies } from "./chat-shared";
export { runGreenfieldChatAdapter } from "./greenfield/chat-adapter";

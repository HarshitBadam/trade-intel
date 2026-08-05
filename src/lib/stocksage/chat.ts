import "server-only";

import { runUnifiedEngine } from "./engine";
import type { ChatDependencies } from "./chat-shared";
import type { ChatReply, ChatRequest } from "./types";

/** Stable public wrapper for the sole regular StockSage engine. */
export async function answerChat(
  request: ChatRequest,
  dependencies: ChatDependencies = {}
): Promise<ChatReply> {
  return runUnifiedEngine(request, dependencies);
}

export type { ChatDependencies } from "./chat-shared";

import "server-only";

import { answerDeepChat } from "./deep";
import { resolveFinanceEntities } from "./entities";
import { classifyIntent, conversationalReply } from "./intent";
import { answerRegularChat } from "./regular";
import type { ChatReply, ChatRequest } from "./types";

export async function answerChat(request: ChatRequest): Promise<ChatReply> {
  const entities = resolveFinanceEntities(request.message, request.history);
  const intent = classifyIntent(
    request.message,
    request.mode,
    entities.length
  );
  const immediate = conversationalReply(intent, request.message);
  if (immediate) return { text: immediate, live: false };

  if (request.mode === "deep") {
    return answerDeepChat(request, entities);
  }
  return answerRegularChat(request, intent, entities);
}

export type {
  ChatMode,
  ChatReply,
  ChatRequest,
  ChatTurn,
} from "./types";

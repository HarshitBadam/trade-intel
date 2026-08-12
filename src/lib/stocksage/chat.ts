import "server-only";

import {
  runSimpleChatAdapter,
  type SimpleRuntimeDependencies,
} from "./simple-runtime";
import type { ChatReply, ChatRequest } from "./types";

export async function answerChat(
  request: ChatRequest,
  dependencies: SimpleRuntimeDependencies = {}
): Promise<ChatReply> {
  return runSimpleChatAdapter(request, dependencies);
}

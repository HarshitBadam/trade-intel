import "server-only";

import {
  llmChatJSON,
  llmChatText,
  type LlmChatArgs,
  type LlmMessage,
} from "@/lib/llm";

export type CerebrasMessage = LlmMessage;

type CerebrasChatArgs = Omit<LlmChatArgs, "vendor">;

export async function cerebrasChatJSON<T = unknown>(
  args: CerebrasChatArgs
): Promise<T> {
  return llmChatJSON<T>({ ...args, vendor: "cerebras" });
}

export async function cerebrasChatText(
  args: CerebrasChatArgs
): Promise<string> {
  return llmChatText({ ...args, vendor: "cerebras" });
}

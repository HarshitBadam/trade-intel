import "server-only";

import { llmChatJSON, type LlmChatArgs } from "./index";

type GroqChatArgs = Omit<LlmChatArgs, "vendor">;

export async function groqChatJSON<T = unknown>(
  args: GroqChatArgs
): Promise<T> {
  return llmChatJSON<T>({ ...args, vendor: "groq" });
}

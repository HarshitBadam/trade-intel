import "server-only";

import {
  LlmRequestError,
  llmChatJSON,
  llmChatText,
  llmErrorSummary,
  shouldTripLlmCircuit,
  type LlmChatArgs,
  type LlmMessage,
} from "@/lib/llm";

export type GroqMessage = LlmMessage;

export { LlmRequestError as GroqRequestError };

type GroqChatArgs = Omit<LlmChatArgs, "vendor">;

export const shouldTripGroqCircuit = shouldTripLlmCircuit;

export const groqErrorSummary = llmErrorSummary;

export async function groqChatJSON<T = unknown>(
  args: GroqChatArgs
): Promise<T> {
  return llmChatJSON<T>({ ...args, vendor: "groq" });
}

export async function groqChatText(args: GroqChatArgs): Promise<string> {
  return llmChatText({ ...args, vendor: "groq" });
}

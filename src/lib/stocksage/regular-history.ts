import type { GroqMessage } from "@/lib/groq";
import { stripUntrustedLinks } from "./citations";
import type { ChatRequest } from "./types";

export function historyMessages(request: ChatRequest): GroqMessage[] {
  return request.history.map((turn) => ({
    role: turn.role === "ai" ? ("assistant" as const) : ("user" as const),
    content:
      turn.role === "ai" ? stripUntrustedLinks(turn.text) : turn.text,
  }));
}

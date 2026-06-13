"use server";

import {
  hasLangflow,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_FLOW_ID,
} from "@/lib/config";
import { guard } from "@/lib/guard";

/**
 * Langflow-backed chat. All endpoints are configurable via env so the flow
 * can be re-hosted anywhere (local Langflow, Langflow Cloud, IBM-hosted, ...).
 *
 * This is the single most cost-sensitive action in the app (it ultimately calls
 * an LLM), so it is auth-gated + rate-limited + input-capped before any
 * outbound request is made.
 */

const MAX_MESSAGE_CHARS = 1000;

export type ChatReply = {
  text: string;
  /** true when the answer came from the live Langflow flow */
  live: boolean;
};

export async function getSummary(message: string): Promise<ChatReply> {
  // 10 messages / minute per user (or per IP in demo mode).
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

  const trimmed = (message ?? "").toString().slice(0, MAX_MESSAGE_CHARS).trim();
  if (!trimmed) {
    return { text: "Ask me about a stock or the market.", live: false };
  }

  if (hasLangflow) {
    try {
      const apiUrl = `${LANGFLOW_BASE_URL}/api/v1/run/${LANGFLOW_FLOW_ID}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LANGFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_value: trimmed,
          output_type: "chat",
          input_type: "chat",
          tweaks: {},
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        throw new Error(`Langflow responded with ${response.status}`);
      }

      const data = await response.json();
      const text =
        data?.outputs?.[0]?.outputs?.[0]?.results?.message?.text ??
        data?.outputs?.[0]?.outputs?.[0]?.results?.message?.data?.text;

      if (text) {
        return { text, live: true };
      }
      throw new Error("Unexpected Langflow response shape");
    } catch (error) {
      console.error("Langflow request failed, using demo reply:", error);
    }
  }

  return { text: demoReply(trimmed), live: false };
}

function demoReply(message: string): string {
  const tickerMatch = message.match(/\b[A-Z]{2,5}\b/);
  const subject = tickerMatch ? tickerMatch[0] : "the market";
  return (
    `(Demo mode) StockSage's AI backend isn't connected yet, so here's a canned take on ${subject}: ` +
    `sentiment looks mixed with cautious optimism from analysts. ` +
    `To get real AI answers, re-host the Langflow flow (langflow.json in the repo root) and set ` +
    `LANGFLOW_BASE_URL, LANGFLOW_FLOW_ID and LANGFLOW_API_KEY in .env.local.`
  );
}

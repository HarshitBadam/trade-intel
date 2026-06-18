"use server";

import {
  hasLangflow,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_FLOW_ID,
} from "@/lib/config";
import { guard } from "@/lib/guard";
import { resolveTickers } from "@/lib/tickers";
import { formatVolume } from "@/lib/movers";
import { getLiveQuotes } from "@/app/details/[id]/actions";

export type ChatTurn = { role: "user" | "ai"; text: string };

/**
 * Builds the payload actually sent to Langflow. The raw user message alone has
 * no memory and no live figures, which makes answers drift between topics and
 * stay vague. We prepend two grounding blocks:
 *   1. Recent conversation, so follow-ups ("how about some numbers?") stay on
 *      the same subject instead of re-querying from scratch.
 *   2. Live quotes (price / % change / volume) for any ticker mentioned in the
 *      latest turn or recently, so the model can answer with real numbers.
 */
async function buildEnrichedMessage(
  message: string,
  history: ChatTurn[]
): Promise<string> {
  // Resolve tickers from the current turn first, then recent turns, so a bare
  // follow-up still carries the subject (e.g. "Tesla" from two messages ago).
  const recentText = [message, ...history.slice(-4).map((t) => t.text)].join(
    " "
  );
  const tickers = resolveTickers(recentText);
  const quotes = await getLiveQuotes(tickers);

  const sections: string[] = [];

  if (quotes.length > 0) {
    const lines = quotes.map((q) => {
      const sign = q.percentChange >= 0 ? "+" : "";
      return `- ${q.ticker}: $${q.price.toFixed(2)}, ${sign}${q.change.toFixed(
        2
      )} (${sign}${q.percentChange.toFixed(2)}%) latest session, volume ${formatVolume(
        q.volume
      )}`;
    });
    sections.push(
      "[LIVE MARKET DATA] Cite these exact figures. Do not invent any others.\n" +
        lines.join("\n")
    );
  }

  if (history.length > 0) {
    const turns = history
      .slice(-6)
      .map((t) => `${t.role === "ai" ? "StockSage" : "User"}: ${t.text}`)
      .join("\n");
    sections.push("[CONVERSATION SO FAR]\n" + turns);
  }

  sections.push("[USER MESSAGE]\n" + message);
  return sections.join("\n\n");
}

/**
 * Langflow-backed chat. All endpoints are configurable via env so the flow
 * can be re-hosted anywhere (local Langflow, Langflow Cloud, IBM-hosted, ...).
 *
 * This is the single most cost-sensitive action in the app (it ultimately calls
 * an LLM), so it is auth-gated + rate-limited + input-capped before any
 * outbound request is made.
 */

const MAX_MESSAGE_CHARS = 1000;

/**
 * Fire-and-forget wake-up for the (possibly sleeping) hosted Langflow Space.
 * Called when the chat widget mounts so the container is booting by the time
 * the user actually sends a message — turning a ~30s cold start into a no-op.
 * Best-effort: any failure is swallowed (the real chat call handles errors).
 */
export async function warmStockSage(): Promise<void> {
  if (!hasLangflow || !LANGFLOW_BASE_URL) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    // Hitting any endpoint on the Space domain triggers HF to wake it; we don't
    // need (or wait for) a useful response.
    await fetch(`${LANGFLOW_BASE_URL}/health`, {
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
    // Ignore — this is only a nudge.
  }
}

export type ChatReply = {
  text: string;
  /** true when the answer came from the live Langflow flow */
  live: boolean;
};

export async function getSummary(
  message: string,
  sessionId?: string,
  history: ChatTurn[] = []
): Promise<ChatReply> {
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

  // A stable per-conversation id lets the RAG flow's memory thread context
  // across turns. Cap its length so a hostile client can't send a huge value.
  const session = (sessionId ?? "").toString().slice(0, 128).trim();

  // Ground the message with recent conversation + live quotes before sending.
  const enriched = await buildEnrichedMessage(trimmed, history);

  if (hasLangflow) {
    try {
      const apiUrl = `${LANGFLOW_BASE_URL}/api/v1/run/${LANGFLOW_FLOW_ID}`;

      const controller = new AbortController();
      // Generous timeout: a HuggingFace Space that has gone to sleep can take
      // tens of seconds to cold-start. Stays under the 60s route maxDuration.
      const timeout = setTimeout(() => controller.abort(), 55_000);

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          // Langflow's run API authenticates via the `x-api-key` header. We also
          // send a Bearer token to cover JWT-style deployments; extra headers are
          // ignored harmlessly by whichever auth mode the server uses.
          "x-api-key": LANGFLOW_API_KEY as string,
          Authorization: `Bearer ${LANGFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_value: enriched,
          output_type: "chat",
          input_type: "chat",
          // session_id threads Langflow's chat memory across turns. Omit it when
          // absent so the flow falls back to its own default session.
          ...(session ? { session_id: session } : {}),
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
      console.error("Langflow request failed:", error);
      // The flow IS configured — this is a transient failure (most often the
      // hosted Space cold-starting after idle), so give an honest, actionable
      // message instead of the "not connected" demo text.
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        text: aborted
          ? "StockSage's AI service was idle and is waking up. The first message after a break can take around 30 seconds. Please send it again in a moment."
          : "StockSage couldn't reach its AI service just now. Please try again in a moment.",
        live: false,
      };
    }
  }

  return { text: demoReply(trimmed), live: false };
}

// Only used when Langflow is genuinely not configured (no env vars set).
function demoReply(message: string): string {
  const tickerMatch = message.match(/\b[A-Z]{2,5}\b/);
  const subject = tickerMatch ? tickerMatch[0] : "the market";
  return (
    `(Demo mode) StockSage's AI backend isn't connected yet, so here's a canned take on ${subject}: ` +
    `sentiment looks mixed with cautious optimism from analysts. ` +
    `To get real AI answers, re-host the Langflow flows (see the langflow/ directory) and set ` +
    `LANGFLOW_BASE_URL, LANGFLOW_FLOW_ID and LANGFLOW_API_KEY in .env.local.`
  );
}

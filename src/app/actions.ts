"use server";

import { unstable_cache } from "next/cache";
import {
  hasLangflow,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_CHAT_LLM_ID,
  LANGFLOW_CHAT_PROMPT_ID,
  LANGFLOW_FLOW_ID,
} from "@/lib/config";
import { guard } from "@/lib/guard";
import { resolveTickers } from "@/lib/tickers";
import { getChatQuotes } from "@/lib/market-data";
import { STOCKSAGE_SYSTEM } from "@/lib/stocksage-prompt";

export type ChatTurn = { role: "user" | "ai"; text: string };

/**
 * Per-request grounding handed to the chat flow's RAG Prompt Builder via
 * Langflow "tweaks". Keeping these OUT of the search query is deliberate: the
 * raw user message is what gets embedded for vector search (clean, relevant
 * retrieval), while live figures / history / focus tickers are injected
 * straight into the prompt the LLM sees. This is what lets answers lead with
 * real numbers and stay on-topic across follow-ups without polluting retrieval.
 */
type ChatGrounding = {
  /** Real price / % change / volume lines for mentioned tickers (or ""). */
  liveData: string;
  /** Recent conversation turns so follow-ups resolve their subject (or ""). */
  history: string;
  /** Comma-separated tickers in scope, so retrieved news stays on-subject. */
  focusTickers: string;
};

function fmtPct(p: number | null): string | null {
  if (p === null || Number.isNaN(p)) return null;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

// Index symbols don't resolve to a tradable per-share quote, so we name them
// explicitly in the grounding. This guarantees the model identifies and
// addresses an index (e.g. "vs IXIC") instead of silently dropping it.
const INDEX_NAMES: Record<string, string> = {
  IXIC: "Nasdaq Composite",
  COMP: "Nasdaq Composite",
  NDX: "Nasdaq 100",
  GSPC: "S&P 500",
  SPX: "S&P 500",
  DJI: "Dow Jones Industrial Average",
  RUT: "Russell 2000",
  VIX: "CBOE Volatility Index",
};

async function buildGrounding(
  message: string,
  history: ChatTurn[]
): Promise<ChatGrounding> {
  // Resolve tickers from the current turn first, then recent turns, so a bare
  // follow-up still carries the subject (e.g. "Tesla" from two messages ago).
  const recentText = [message, ...history.slice(-4).map((t) => t.text)].join(
    " "
  );
  const tickers = resolveTickers(recentText);

  // Indices have no per-share quote; everything else gets a real multi-horizon
  // quote from per-ticker aggregates.
  const indices = tickers.filter((t) => INDEX_NAMES[t]);
  const equities = tickers.filter((t) => !INDEX_NAMES[t]);
  const quotes = await getChatQuotes(equities);

  // One dense, quantitative line per ticker: price + multi-horizon performance.
  // This is what lets answers lead with real numbers for ANY ticker, with no
  // dependency on the dashboard having been visited first.
  const quoteLines = quotes.map((q) => {
    const horizons = [
      `day ${fmtPct(q.dayPct)}`,
      q.weekPct !== null ? `1W ${fmtPct(q.weekPct)}` : null,
      q.monthPct !== null ? `1M ${fmtPct(q.monthPct)}` : null,
      q.yearPct !== null ? `1Y ${fmtPct(q.yearPct)}` : null,
    ].filter(Boolean);
    return `- ${q.ticker}: $${q.price.toFixed(2)} (${horizons.join(", ")})`;
  });

  // Name any index the user referenced so the model never drops it.
  const indexLines = indices.map(
    (t) => `- ${t}: ${INDEX_NAMES[t]} (market index; refer to it by name)`
  );

  const liveData = [...quoteLines, ...indexLines].join("\n");

  const historyText =
    history.length > 0
      ? history
          .slice(-6)
          .map((t) => `${t.role === "ai" ? "StockSage" : "User"}: ${t.text}`)
          .join("\n")
      : "";

  return { liveData, history: historyText, focusTickers: tickers.join(", ") };
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

/**
 * Resolve the chat flow's node IDs from the *live* hosted flow.
 *
 * Langflow regenerates every node's random suffix on import (e.g.
 * `StockSageRagPrompt-FwmYE` → `StockSageRagPrompt-p58fa`), and any tweak aimed
 * at an ID that no longer exists is silently dropped — which previously killed
 * all of our grounding and the system-message override after a re-import.
 *
 * So rather than hard-code IDs that drift, we read the flow once and match nodes
 * by their stable prefix. The result is cached, so this is one extra request per
 * cache window (not per chat), and it self-heals across future re-imports.
 * Falls back to the configured IDs if the lookup can't run.
 */
const resolveChatNodeIds = unstable_cache(
  async (): Promise<{ promptId: string; llmId: string }> => {
    const fallback = {
      promptId: LANGFLOW_CHAT_PROMPT_ID,
      llmId: LANGFLOW_CHAT_LLM_ID,
    };
    if (!hasLangflow || !LANGFLOW_BASE_URL) return fallback;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(
        `${LANGFLOW_BASE_URL}/api/v1/flows/${LANGFLOW_FLOW_ID}`,
        {
          headers: { "x-api-key": LANGFLOW_API_KEY as string },
          cache: "no-store",
          signal: controller.signal,
        }
      ).finally(() => clearTimeout(timeout));
      if (!res.ok) return fallback;
      const flow = await res.json();
      const nodes: Array<{ id?: unknown }> = flow?.data?.nodes ?? [];
      const idByPrefix = (prefix: string, fb: string): string => {
        const hit = nodes.find(
          (n) => typeof n.id === "string" && (n.id as string).startsWith(prefix)
        );
        return typeof hit?.id === "string" ? (hit.id as string) : fb;
      };
      return {
        promptId: idByPrefix("StockSageRagPrompt", fallback.promptId),
        llmId: idByPrefix("LanguageModel", fallback.llmId),
      };
    } catch {
      return fallback;
    }
  },
  ["langflow-chat-node-ids"],
  { revalidate: 1800 }
);

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

  // Live quotes + conversation + focus tickers, kept separate from the search
  // query so retrieval stays clean (see buildGrounding). Resolve the live node
  // IDs in parallel so tweaks land on the right nodes regardless of re-imports.
  const [grounding, nodeIds] = await Promise.all([
    buildGrounding(trimmed, history),
    resolveChatNodeIds(),
  ]);

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
          // The CLEAN user message is what gets embedded for Astra vector
          // search and shown as the question. Grounding goes via tweaks below.
          input_value: trimmed,
          output_type: "chat",
          input_type: "chat",
          // session_id threads Langflow's chat memory across turns. Omit it when
          // absent so the flow falls back to its own default session.
          ...(session ? { session_id: session } : {}),
          // Inject grounding straight into the RAG Prompt Builder so the LLM
          // leads with live figures and resolves follow-ups, without polluting
          // the retrieval query. Also push the behavioural contract onto the
          // Language Model node so StockSage's voice is owned by the app (no
          // flow re-import needed to refine it).
          tweaks: {
            [nodeIds.promptId]: {
              live_data: grounding.liveData,
              history: grounding.history,
              focus_tickers: grounding.focusTickers,
            },
            [nodeIds.llmId]: {
              system_message: STOCKSAGE_SYSTEM,
            },
          },
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

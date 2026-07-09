import "server-only";

import { unstable_cache } from "next/cache";
import {
  GROQ_CHAT_MODEL,
  hasGroq,
  hasLangflow,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_CHAT_LLM_ID,
  LANGFLOW_CHAT_PROMPT_ID,
  LANGFLOW_FLOW_ID,
} from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import { groqChatText } from "@/lib/groq";
import { runLangflowFlow } from "@/lib/langflow";
import { resolveTickers } from "@/lib/tickers";
import { getChatQuotes } from "@/lib/market-data";
import type { ChatQuote } from "@/lib/market-data";
import { STOCKSAGE_SYSTEM } from "@/lib/stocksage/prompt";

// StockSage chat engine (Task 6). Langflow-first (the visible orchestration: RAG
// over Astra news + a live Tavily web search + the app's grounding), with a REAL
// direct-Groq fallback on the same 70B model + system prompt so a downed Space
// still answers. This is the testable core; the "use server" action in
// app/actions.ts is a thin guard + wrapper around answerChat.

export type ChatTurn = { role: "user" | "ai"; text: string };

export type ChatReply = {
  text: string;
  live: boolean;
  retryable?: boolean;
};

type ChatGrounding = {
  liveData: string;
  history: string;
  focusTickers: string;
  quotes: ChatQuote[];
  indices: string[];
};

const MAX_MESSAGE_CHARS = 1000;

function fmtPct(p: number | null): string | null {
  if (p === null || Number.isNaN(p)) return null;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

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
  const recentText = [message, ...history.slice(-4).map((t) => t.text)].join(
    " "
  );
  const tickers = resolveTickers(recentText);

  const indices = tickers.filter((t) => INDEX_NAMES[t]);
  const equities = tickers.filter((t) => !INDEX_NAMES[t]);
  const quotes = await getChatQuotes(equities);

  const quoteLines = quotes.map((q) => {
    const horizons = [
      `day ${fmtPct(q.dayPct)}`,
      q.weekPct !== null ? `1W ${fmtPct(q.weekPct)}` : null,
      q.monthPct !== null ? `1M ${fmtPct(q.monthPct)}` : null,
      q.yearPct !== null ? `1Y ${fmtPct(q.yearPct)}` : null,
    ].filter(Boolean);
    return `- ${q.ticker}: $${q.price.toFixed(2)} (${horizons.join(", ")})`;
  });

  const indexLines = indices.map(
    (t) => `- ${t}: ${INDEX_NAMES[t]} (market index; refer to it by name)`
  );

  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(new Date());
  const dateLine = `Today's date is ${today} (US Eastern). Treat this as the current date when judging how recent any news or figure is.`;

  const liveData = [dateLine, ...quoteLines, ...indexLines].join("\n");

  const historyText =
    history.length > 0
      ? history
          .slice(-6)
          .map((t) => `${t.role === "ai" ? "StockSage" : "User"}: ${t.text}`)
          .join("\n")
      : "";

  return {
    liveData,
    history: historyText,
    focusTickers: tickers.join(", "),
    quotes,
    indices,
  };
}

// The grounding block for the Groq fallback: the SAME live_data / focus_tickers
// / history the flow's RAG prompt builder would have received via tweaks (minus
// the Astra/Tavily context the direct path has no access to). Section headings
// mirror the flow prompt so the 70B model reads it the same way.
function buildGroundingBlock(g: ChatGrounding): string {
  const parts: string[] = [];
  if (g.liveData) {
    parts.push(
      "LIVE MARKET DATA (quote these figures exactly; never alter or invent any):\n" +
        g.liveData
    );
  }
  if (g.focusTickers) {
    parts.push("FOCUS TICKERS (entities in scope): " + g.focusTickers);
  }
  if (g.history) {
    parts.push(
      "EARLIER CONVERSATION (resolve any follow-up reference against this thread):\n" +
        g.history
    );
  }
  return parts.join("\n\n");
}

// Deterministic snapshot from the live figures we already fetched — the LAST
// resort when both Langflow AND Groq are unavailable, so the user still gets
// something concrete instead of an error.
function fallbackReply(grounding: ChatGrounding): string {
  const { quotes, indices } = grounding;

  if (quotes.length === 0 && indices.length === 0) {
    return (
      "StockSage is taking a moment to respond. Please try again shortly. " +
      "You can also ask about a specific ticker like AAPL or TSLA for a live market snapshot."
    );
  }

  const lines: string[] = [];
  for (const q of quotes) {
    const read = q.dayPct > 0.25 ? "Bullish" : q.dayPct < -0.25 ? "Bearish" : "Mixed";
    const dir = q.dayPct > 0.25 ? "up" : q.dayPct < -0.25 ? "down" : "roughly flat";
    const horizons = [
      q.weekPct !== null ? `1W ${fmtPct(q.weekPct)}` : null,
      q.monthPct !== null ? `1M ${fmtPct(q.monthPct)}` : null,
      q.yearPct !== null ? `1Y ${fmtPct(q.yearPct)}` : null,
    ].filter(Boolean);
    const tail = horizons.length ? ` (${horizons.join(", ")})` : "";
    lines.push(
      `**${q.ticker}** is at $${q.price.toFixed(2)}, ${dir} ${fmtPct(q.dayPct) ?? "0.0%"} today${tail}. Read: ${read}.`
    );
  }
  for (const t of indices) {
    lines.push(`**${t}** is the ${INDEX_NAMES[t]}.`);
  }

  return [
    "Here's a quick snapshot from the latest market data:",
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    "_Ask again in a moment for StockSage's full analysis._",
  ].join("\n");
}

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

// Langflow regenerates node-id suffixes on every import, so the app resolves the
// prompt + LLM node ids from the live flow by prefix and only falls back to the
// configured defaults if the flow can't be reached. Task 6: the LLM node is now
// the Groq component, so the prefix moved from "LanguageModel" to "GroqModel".
const fetchChatNodeIds = unstable_cache(
  async (): Promise<{ promptId: string; llmId: string }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50_000);
    const res = await fetch(
      `${LANGFLOW_BASE_URL}/api/v1/flows/${LANGFLOW_FLOW_ID}`,
      {
        headers: { "x-api-key": LANGFLOW_API_KEY as string },
        cache: "no-store",
        signal: controller.signal,
      }
    ).finally(() => clearTimeout(timeout));
    if (!res.ok) throw new Error(`flow fetch failed: ${res.status}`);
    const flow = await res.json();
    const nodes: Array<{ id?: unknown }> = flow?.data?.nodes ?? [];
    const idByPrefix = (prefix: string): string | undefined => {
      const hit = nodes.find(
        (n) => typeof n.id === "string" && (n.id as string).startsWith(prefix)
      );
      return typeof hit?.id === "string" ? (hit.id as string) : undefined;
    };
    const promptId = idByPrefix("StockSageRagPrompt");
    const llmId = idByPrefix("GroqModel");
    if (!promptId || !llmId) {
      throw new Error("chat flow is missing expected nodes");
    }
    return { promptId, llmId };
  },
  ["langflow-chat-node-ids"],
  { revalidate: 1800 }
);

async function resolveChatNodeIds(): Promise<{
  promptId: string;
  llmId: string;
}> {
  const fallback = {
    promptId: LANGFLOW_CHAT_PROMPT_ID,
    llmId: LANGFLOW_CHAT_LLM_ID,
  };
  if (!hasLangflow || !LANGFLOW_BASE_URL) return fallback;
  try {
    return await fetchChatNodeIds();
  } catch (error) {
    console.error("Chat node-id resolution failed, using fallback:", error);
    return fallback;
  }
}

// Warm the Langflow Space so the first real message isn't paying cold-start
// latency. Never pings when the "langflow" breaker is open — a Space we already
// know is down shouldn't be poked (D13), and the chat will serve via Groq.
export async function warmStockSage(): Promise<void> {
  if (!hasLangflow || !LANGFLOW_BASE_URL) return;
  if (await isOpen("langflow")) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    await fetch(`${LANGFLOW_BASE_URL}/health`, {
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
    // Best-effort warm-up; a failure here is not worth surfacing.
  }
}

export async function answerChat(
  message: string,
  sessionId?: string,
  history: ChatTurn[] = []
): Promise<ChatReply> {
  const trimmed = (message ?? "").toString().slice(0, MAX_MESSAGE_CHARS).trim();
  if (!trimmed) {
    return { text: "Ask me about a stock or the market.", live: false };
  }

  const session = (sessionId ?? "").toString().slice(0, 128).trim();

  const [grounding, nodeIds] = await Promise.all([
    buildGrounding(trimmed, history),
    resolveChatNodeIds(),
  ]);

  const langflowOpen = await isOpen("langflow");

  // Lane 1 — Langflow-first, but skip entirely if the breaker is open so a dead
  // Space doesn't cost a 55s timeout on every message.
  if (hasLangflow && !langflowOpen) {
    try {
      const text = await runLangflowFlow({
        flowId: LANGFLOW_FLOW_ID as string,
        input: trimmed,
        sessionId: session || undefined,
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
      });
      await recordSuccess("langflow");
      console.info("[chat] served by Langflow");
      return { text, live: true };
    } catch (error) {
      await recordFailure("langflow");
      console.error(
        "[chat] Langflow request failed, falling back to direct Groq:",
        error
      );
    }
  } else if (langflowOpen) {
    console.info("[chat] Langflow breaker open; serving via direct Groq");
  }

  // Lane 2 — real Groq fallback on the SAME 70B model + StockSage system prompt,
  // grounded with the same live_data/history/focus_tickers the flow would get.
  if (hasGroq) {
    try {
      const groundingBlock = buildGroundingBlock(grounding);
      const system = groundingBlock
        ? `${STOCKSAGE_SYSTEM}\n\n${groundingBlock}`
        : STOCKSAGE_SYSTEM;
      const text = await groqChatText({
        model: GROQ_CHAT_MODEL,
        system,
        user: trimmed,
        temperature: 0.4,
      });
      console.info("[chat] served by direct Groq fallback");
      return { text, live: true };
    } catch (error) {
      console.error("[chat] Groq fallback failed:", error);
    }
  }

  // Lane 3 — last resort. A canned snapshot from the live figures when a real
  // backend exists but both AI lanes failed; pure demo text otherwise.
  if (hasLangflow || hasGroq) {
    console.info("[chat] served by canned market-snapshot fallback");
    return { text: fallbackReply(grounding), live: false };
  }
  return { text: demoReply(trimmed), live: false };
}

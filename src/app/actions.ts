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
import type { ChatQuote } from "@/lib/market-data";
import { STOCKSAGE_SYSTEM } from "@/lib/stocksage/prompt";

export type ChatTurn = { role: "user" | "ai"; text: string };

type ChatGrounding = {
  liveData: string;
  history: string;
  focusTickers: string;
  quotes: ChatQuote[];
  indices: string[];
};

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

const MAX_MESSAGE_CHARS = 1000;

export async function warmStockSage(): Promise<void> {
  if (!hasLangflow || !LANGFLOW_BASE_URL) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    await fetch(`${LANGFLOW_BASE_URL}/health`, {
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
  }
}

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
    const llmId = idByPrefix("LanguageModel");
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

export type ChatReply = {
  text: string;
  live: boolean;
  retryable?: boolean;
};

export async function getSummary(
  message: string,
  sessionId?: string,
  history: ChatTurn[] = []
): Promise<ChatReply> {
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

  const session = (sessionId ?? "").toString().slice(0, 128).trim();

  const [grounding, nodeIds] = await Promise.all([
    buildGrounding(trimmed, history),
    resolveChatNodeIds(),
  ]);

  if (hasLangflow) {
    try {
      const apiUrl = `${LANGFLOW_BASE_URL}/api/v1/run/${LANGFLOW_FLOW_ID}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55_000);

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "x-api-key": LANGFLOW_API_KEY as string,
          Authorization: `Bearer ${LANGFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_value: trimmed,
          output_type: "chat",
          input_type: "chat",
          ...(session ? { session_id: session } : {}),
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
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        text: fallbackReply(grounding),
        live: false,
        retryable: aborted,
      };
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
    `To get real AI answers, re-host the Langflow flows (see the langflow/ directory) and set ` +
    `LANGFLOW_BASE_URL, LANGFLOW_FLOW_ID and LANGFLOW_API_KEY in .env.local.`
  );
}

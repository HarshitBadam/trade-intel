import "server-only";

import { unstable_cache } from "next/cache";
import {
  hasLangflow,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_CHAT_LLM_ID,
  LANGFLOW_CHAT_PROMPT_ID,
  LANGFLOW_FLOW_ID,
} from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import { runLangflowFlow } from "@/lib/langflow";
import { getChatQuotes, type ChatQuote } from "@/lib/market-data";
import { sanitizeExternalCitations } from "./citations";
import { STOCKSAGE_DEEP_SYSTEM } from "./prompt";
import type {
  ChatReply,
  ChatRequest,
  FinanceEntity,
} from "./types";

function percent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "not available";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function liveData(quotes: ChatQuote[]): string {
  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(new Date());
  const lines = quotes.map(
    (quote) =>
      `${quote.ticker}: $${quote.price.toFixed(2)}, day ${percent(quote.dayPct)}, 1W ${percent(quote.weekPct)}, 1M ${percent(quote.monthPct)}, 1Y ${percent(quote.yearPct)}`
  );
  return [`Today is ${today} in US Eastern time.`, ...lines].join("\n");
}

const fetchChatNodeIds = unstable_cache(
  async (): Promise<{ promptId: string; llmId: string }> => {
    const response = await fetch(
      `${LANGFLOW_BASE_URL}/api/v1/flows/${LANGFLOW_FLOW_ID}`,
      {
        headers: { "x-api-key": LANGFLOW_API_KEY as string },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!response.ok) throw new Error(`Flow fetch failed: ${response.status}`);
    const flow = await response.json();
    const nodes: Array<{ id?: unknown }> = flow?.data?.nodes ?? [];
    const idByPrefix = (prefix: string) =>
      nodes.find(
        (node) =>
          typeof node.id === "string" && node.id.startsWith(prefix)
      )?.id;
    const promptId = idByPrefix("StockSageRagPrompt");
    const llmId = idByPrefix("GroqModel");
    if (typeof promptId !== "string" || typeof llmId !== "string") {
      throw new Error("Chat flow is missing expected nodes");
    }
    return { promptId, llmId };
  },
  ["langflow-chat-node-ids"],
  { revalidate: 1800 }
);

async function resolveNodeIds(): Promise<{
  promptId: string;
  llmId: string;
}> {
  const fallback = {
    promptId: LANGFLOW_CHAT_PROMPT_ID,
    llmId: LANGFLOW_CHAT_LLM_ID,
  };
  try {
    return await fetchChatNodeIds();
  } catch (error) {
    console.error("[chat] Deep Research node resolution failed:", error);
    return fallback;
  }
}

export async function answerDeepChat(
  request: ChatRequest,
  entities: FinanceEntity[]
): Promise<ChatReply> {
  if (!hasLangflow || !LANGFLOW_FLOW_ID) {
    return {
      text: "Deep Research isn’t configured right now. Select regular mode for a standard StockSage answer.",
      live: false,
    };
  }
  if (await isOpen("langflow")) {
    return {
      text: "Deep Research is temporarily unavailable. Please try again shortly or use regular mode.",
      live: false,
      retryable: true,
    };
  }

  const usTickers = entities
    .filter((entity) => entity.market === "us" && entity.ticker)
    .map((entity) => entity.ticker as string)
    .slice(0, 4);
  const [quotes, nodeIds] = await Promise.all([
    getChatQuotes(usTickers).catch(() => []),
    resolveNodeIds(),
  ]);
  const history = request.history
    .map((turn) => `${turn.role === "ai" ? "StockSage" : "User"}: ${turn.text}`)
    .join("\n");
  const focus = entities
    .map((entity) => entity.ticker ?? entity.name)
    .join(", ");

  try {
    const text = await runLangflowFlow({
      flowId: LANGFLOW_FLOW_ID,
      input: request.message,
      sessionId: request.sessionId,
      tweaks: {
        [nodeIds.promptId]: {
          live_data: liveData(quotes),
          history,
          focus_tickers: focus,
        },
        [nodeIds.llmId]: {
          system_message: STOCKSAGE_DEEP_SYSTEM,
        },
      },
      timeoutMs: 35_000,
    });
    await recordSuccess("langflow");
    const sanitized = sanitizeExternalCitations(text);
    return { ...sanitized, live: true };
  } catch (error) {
    await recordFailure("langflow");
    console.error("[chat] Deep Research Langflow request failed:", error);
    return {
      text: "Deep Research couldn’t complete this request. Please try again shortly or switch to regular mode.",
      live: false,
      retryable: true,
    };
  }
}

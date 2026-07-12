import "server-only";

import { unstable_cache } from "next/cache";
import { z } from "zod";
import {
  hasDeepResearch,
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
import {
  parseDeepResearchSnapshot,
  type DeepResearchSnapshot,
} from "./deep-snapshot";
import { runIdempotentDeepWork } from "./deep-store";
import { validateDeepResearchResult } from "./deep-validation";
import { STOCKSAGE_DEEP_SYSTEM } from "./prompt";
import type { DeepResearchReply } from "./types";

const FlowSchema = z.object({
  data: z.object({
    nodes: z.array(z.object({ id: z.string().optional() })).default([]),
  }),
});

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
      `${quote.ticker}: as of ${quote.asOf}, $${quote.price.toFixed(2)}, day ${percent(quote.dayPct)}, 1W ${percent(quote.weekPct)}, 1M ${percent(quote.monthPct)}, 1Y ${percent(quote.yearPct)}`
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
    const flow = FlowSchema.parse(await response.json());
    const nodes = flow.data.nodes;
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

async function executeDeepResearch(
  snapshot: DeepResearchSnapshot
): Promise<DeepResearchReply> {
  if (!hasDeepResearch || !LANGFLOW_FLOW_ID) {
    return {
      workId: snapshot.workId,
      status: "failure",
      text: "Research deeper isn’t configured right now.",
    };
  }
  if (await isOpen("langflow-deep")) {
    return {
      workId: snapshot.workId,
      status: "failure",
      text: "Research deeper is temporarily unavailable. Please try again shortly.",
      retryable: true,
    };
  }

  const usTickers = snapshot.entities
    .filter((entity) => entity.market === "us" && entity.ticker)
    .map((entity) => entity.ticker as string)
    .slice(0, 4);
  const [quotes, nodeIds] = await Promise.all([
    getChatQuotes(usTickers).catch(() => []),
    resolveNodeIds(),
  ]);
  const focus = snapshot.entities
    .map((entity) => entity.ticker ?? entity.name)
    .join(", ");
  const input = [
    `Original question: ${snapshot.question}`,
    `Regular answer: ${snapshot.regularAnswer}`,
    `As of: ${snapshot.asOf}`,
    `Entities: ${focus || "none"}`,
    `Criteria: ${snapshot.criteria.join(", ") || "not specified"}`,
    `Horizon: ${snapshot.horizon ?? "not specified"}`,
    `Jurisdiction: ${snapshot.jurisdiction ?? "not specified"}`,
    `Prior evidence identifiers: ${snapshot.evidenceIds.join(", ") || "none"}`,
  ].join("\n");

  try {
    const text = await runLangflowFlow({
      flowId: LANGFLOW_FLOW_ID,
      input,
      sessionId: snapshot.workId,
      tweaks: {
        [nodeIds.promptId]: {
          live_data: liveData(quotes),
          focus_tickers: focus,
        },
        [nodeIds.llmId]: {
          system_message: STOCKSAGE_DEEP_SYSTEM,
        },
      },
      timeoutMs: 35_000,
    });
    await recordSuccess("langflow-deep");
    const sanitized = sanitizeExternalCitations(text);
    const validationError = validateDeepResearchResult({
      snapshot,
      text: sanitized.text,
      citationUrls: sanitized.citationUrls,
    });
    if (validationError) {
      return {
        workId: snapshot.workId,
        status: "failure",
        text: validationError,
        retryable: true,
      };
    }
    return {
      workId: snapshot.workId,
      status: "success",
      ...sanitized,
    };
  } catch (error) {
    await recordFailure("langflow-deep");
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "deep_failure",
        provider: "langflow-deep",
        reason: error instanceof Error ? error.name : "unknown",
      })}`
    );
    return {
      workId: snapshot.workId,
      status: "failure",
      text: "Research deeper couldn’t complete this request. The regular answer remains available.",
      retryable: true,
    };
  }
}

export async function runDeepResearch(
  token: unknown
): Promise<DeepResearchReply> {
  const snapshot = parseDeepResearchSnapshot(token);
  if (!snapshot) {
    return {
      workId: "invalid",
      status: "failure",
      text: "This research request is invalid or expired.",
    };
  }
  return runIdempotentDeepWork(snapshot.workId, () =>
    executeDeepResearch(snapshot)
  );
}

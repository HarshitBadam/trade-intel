import "server-only";

import { z } from "zod";
import {
  GROQ_ANALYSIS_MODEL,
  hasLangflowAnalyze,
  LANGFLOW_ANALYZE_FLOW_ID,
} from "@/lib/config";
import { groqChatJSON } from "@/lib/groq";
import { runLangflowFlow } from "@/lib/langflow";
import { parseFencedJson } from "@/lib/llm-json";
import { ANALYSIS_INSTRUCTIONS } from "@/lib/stocksage/analysis-prompt";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import type { StoredArticle } from "./types";

// Token budget guard for the 8B model: newest N after windowing. Groq's free
// tier caps at 6,000 tokens/minute AND counts the max_tokens completion
// reservation against it, so the ceiling is (prompt + ANALYSIS_MAX_TOKENS) < 6,000.
// 25 articles keeps the prompt near ~2.6k tokens.
export const MAX_ARTICLES_PER_PASS = 25;
export const ANALYSIS_MAX_TOKENS = 2400;
export const DESCRIPTION_CHARS = 300;

type PromptArticle = {
  article_id: string;
  date: string;
  title: string;
  description: string;
};

export function buildUserPrompt(symbol: string, articles: PromptArticle[]): string {
  return [
    `Ticker: ${symbol}`,
    `Article count: ${articles.length}`,
    "Articles (JSON):",
    JSON.stringify(articles),
  ].join("\n");
}

export function toPromptArticle(a: StoredArticle): PromptArticle {
  const description = (
    a.metadata.description ||
    a.page_content ||
    a.metadata.key_observations ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DESCRIPTION_CHARS);
  return {
    article_id: a._id,
    date: a.metadata.publication_date ?? "",
    title: a.metadata.title ?? "Untitled",
    description,
  };
}

export const ResponseSchema = z.object({
  articles: z
    .array(
      z.object({
        article_id: z.string(),
        sentiment: z.string(),
        importance: z.string().optional(),
        key_observations: z.string().optional(),
      })
    )
    .default([]),
  verdict: z.object({
    overall_sentiment: z.string(),
    sentiment_score: z.number(),
    confidence: z.string().optional(),
    summary: z.string(),
    key_drivers: z
      .array(
        z.object({
          text: z.string(),
          sentiment: z.string().optional(),
          article_ids: z.array(z.string()).default([]),
        })
      )
      .default([]),
    risks: z.array(z.string()).default([]),
  }),
});

export function normSentiment3(
  raw: string | undefined
): "Positive" | "Negative" | "Neutral" | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "positive":
      return "Positive";
    case "negative":
      return "Negative";
    case "neutral":
      return "Neutral";
    default:
      return null;
  }
}

export function normOverall(
  raw: string
): "Positive" | "Negative" | "Neutral" | "Mixed" | null {
  if ((raw ?? "").trim().toLowerCase() === "mixed") return "Mixed";
  return normSentiment3(raw);
}

// "Medium" is the established neutral default (providers use it too), so an odd
// label degrades gracefully rather than failing the row.
export function normLevel(raw: string | undefined): "High" | "Medium" | "Low" {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "high":
      return "High";
    case "low":
      return "Low";
    default:
      return "Medium";
  }
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

// Langflow-first, Groq-direct-fallback. If the analysis flow is configured and
// the "langflow" breaker is closed, run the flow. On any Langflow failure — or
// when Langflow isn't configured / its breaker is open — fall through to the
// direct Groq call. The `system` argument is used only by the direct path; the
// flow carries its instructions internally.
export async function runAnalysisLLM(user: string): Promise<unknown> {
  if (hasLangflowAnalyze && LANGFLOW_ANALYZE_FLOW_ID && !(await isOpen("langflow"))) {
    try {
      const text = await runLangflowFlow({
        flowId: LANGFLOW_ANALYZE_FLOW_ID,
        input: user,
      });
      const parsed = parseFencedJson(text);
      await recordSuccess("langflow");
      return parsed;
    } catch (error) {
      await recordFailure("langflow");
      console.error("[analysis] Langflow lane failed, falling back to direct Groq:", error);
    }
  }

  try {
    const raw = await groqChatJSON({
      model: GROQ_ANALYSIS_MODEL,
      system: ANALYSIS_INSTRUCTIONS,
      user,
      maxTokens: ANALYSIS_MAX_TOKENS,
    });
    await recordSuccess("groq");
    return raw;
  } catch (error) {
    await recordFailure("groq");
    throw error;
  }
}

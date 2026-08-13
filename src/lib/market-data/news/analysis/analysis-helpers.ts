import "server-only";

import { z } from "zod";
import {
  GROQ_ANALYSIS_MODEL,
} from "@/lib/config";
import { groqChatJSON } from "@/lib/llm/groq";
import { ANALYSIS_INSTRUCTIONS } from "./analysis-prompt";
import { isOpen, recordFailure, recordSuccess } from "@/lib/resilience/breaker";
import type { StoredArticle } from "../../types";

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

export async function runAnalysisLLM(user: string): Promise<unknown> {
  if (await isOpen("groq-analysis")) {
    throw new Error("groq analysis is temporarily unavailable");
  }
  try {
    const raw = await groqChatJSON({
      model: GROQ_ANALYSIS_MODEL,
      system: ANALYSIS_INSTRUCTIONS,
      user,
      maxTokens: ANALYSIS_MAX_TOKENS,
    });
    await recordSuccess("groq-analysis");
    return raw;
  } catch (error) {
    await recordFailure("groq-analysis");
    throw error;
  }
}

import "server-only";

import { hasTavily, TAVILY_API_KEY } from "@/lib/config";
import type { EvidenceInput } from "./citations";

type TavilyTopic = "general" | "news";

type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
};

type TavilyResponse = {
  results?: TavilyResult[];
};

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 8_000;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outlet(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web";
  }
}

export async function searchTavily(
  query: string,
  topic: TavilyTopic
): Promise<EvidenceInput[]> {
  if (!hasTavily || !TAVILY_API_KEY) return [];

  try {
    const response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.slice(0, 500),
        topic,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        ...(topic === "news" ? { days: 14 } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Tavily responded with ${response.status}`);
    }

    const data = (await response.json()) as TavilyResponse;
    return (data.results ?? []).slice(0, 5).map((result) => {
      const url = stringValue(result.url);
      return {
        kind: "tavily" as const,
        title: stringValue(result.title),
        outlet: outlet(url),
        publishedAt: stringValue(result.published_date) || undefined,
        url,
        excerpt: stringValue(result.content),
      };
    });
  } catch (error) {
    console.error("[chat] Tavily retrieval failed:", error);
    return [];
  }
}

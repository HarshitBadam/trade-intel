import "server-only";

import { z } from "zod";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import { hasTavily, TAVILY_API_KEY } from "@/lib/config";
import type { EvidenceInput } from "./citations";
import type { EvidenceQuery } from "./types";

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 8_000;

const TavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().optional(),
        published_date: z.string().optional(),
        score: z.number().optional(),
      })
    )
    .default([]),
});

function outlet(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web";
  }
}

export async function searchTavily(
  query: EvidenceQuery
): Promise<EvidenceInput[]> {
  if (
    query.provider !== "tavily" ||
    !hasTavily ||
    !TAVILY_API_KEY ||
    (await isOpen("tavily"))
  ) {
    return [];
  }

  try {
    const response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.query.slice(0, 500),
        topic: query.topic,
        search_depth: "basic",
        max_results: query.limit,
        include_answer: false,
        include_raw_content: false,
        ...(query.freshnessDays ? { days: query.freshnessDays } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Tavily responded with ${response.status}`);
    }

    const parsed = TavilyResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Tavily returned an invalid response");
    await recordSuccess("tavily");
    const retrievedAt = new Date().toISOString();
    return parsed.data.results.slice(0, query.limit).map((result) => {
      const url = result.url ?? "";
      return {
        kind: "tavily" as const,
        title: result.title ?? "",
        outlet: outlet(url),
        publishedAt: result.published_date,
        url,
        excerpt: result.content ?? "",
        score: result.score,
        entityIds: query.entityIds,
        criteria: query.criteria,
        retrievedAt,
        queryId: query.id,
      };
    });
  } catch (error) {
    await recordFailure("tavily");
    console.error("[chat] Tavily retrieval failed:", error);
    return [];
  }
}

import "server-only";

import { z } from "zod";
import {
  isCoolingDown,
  isOpen,
  recordCooldown,
  recordFailure,
  recordSuccess,
  recordUnavailable,
} from "@/lib/resilience/breaker";
import { hasTavily, TAVILY_API_KEY } from "@/lib/config";
import type { EvidenceInput } from "./citations";
import type { EvidenceQuery } from "./types";

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 8_000;
const TAVILY_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

class TavilyHttpError extends Error {
  constructor(readonly status: number) {
    super(`Tavily responded with ${status}`);
    this.name = "TavilyHttpError";
  }
}

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

function validPublicUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type TavilySearchStatus = "ok" | "no_results" | "unavailable";

export type TavilySearchResult = {
  status: TavilySearchStatus;
  evidence: EvidenceInput[];
  reason?: string;
};

export async function searchTavilyDetailed(
  query: EvidenceQuery
): Promise<TavilySearchResult> {
  if (query.provider !== "tavily") {
    return { status: "unavailable", evidence: [], reason: "wrong_provider" };
  }
  if (!hasTavily || !TAVILY_API_KEY) {
    return { status: "unavailable", evidence: [], reason: "not_configured" };
  }
  if (await isOpen("tavily")) {
    return { status: "unavailable", evidence: [], reason: "circuit_open" };
  }
  if (await isCoolingDown("tavily")) {
    return { status: "unavailable", evidence: [], reason: "cooldown" };
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
      throw new TavilyHttpError(response.status);
    }

    const parsed = TavilyResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Tavily returned an invalid response");
    await recordSuccess("tavily");
    const retrievedAt = new Date().toISOString();
    const evidence = parsed.data.results
      .filter(
        (
          result
        ): result is typeof result & { url: string } =>
          validPublicUrl(result.url)
      )
      .slice(0, query.limit)
      .map((result) => {
        const url = result.url;
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
    return {
      status: evidence.length > 0 ? "ok" : "no_results",
      evidence,
    };
  } catch (error) {
    if (error instanceof TavilyHttpError && error.status === 432) {
      await Promise.all([
        recordCooldown("tavily", TAVILY_QUOTA_COOLDOWN_MS),
        recordUnavailable("tavily"),
      ]);
    } else {
      await recordFailure("tavily");
    }
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "retrieval_failure",
        provider: "tavily",
        reason:
          error instanceof TavilyHttpError
            ? `http_${error.status}`
            : error instanceof Error
              ? error.name
              : "unknown",
      })}`
    );
    return {
      status: "unavailable",
      evidence: [],
      reason:
        error instanceof TavilyHttpError
          ? `http_${error.status}`
          : error instanceof Error
            ? error.name
            : "unknown",
    };
  }
}

export async function searchTavily(
  query: EvidenceQuery
): Promise<EvidenceInput[]> {
  return (await searchTavilyDetailed(query)).evidence;
}

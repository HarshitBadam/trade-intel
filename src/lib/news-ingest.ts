import "server-only";

import { revalidateTag } from "next/cache";
import {
  hasLangflowIngest,
  hasUpstash,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_INGEST_FLOW_ID,
  LANGFLOW_INGEST_STRUCTURED_ID,
  LANGFLOW_INGEST_TAVILY_ID,
} from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";

// A SUCCESSFUL ingest keeps the ticker quiet for 6h (avoids duplicate rows and
// Gemini spam). Failed attempts only block retries for 10 minutes, so a
// transient Langflow outage doesn't freeze refreshes for 6 hours.
const SUCCESS_QUIET_S = 6 * 60 * 60;
const ATTEMPT_QUIET_S = 10 * 60;

const successMemory = new Map<string, number>();

async function hadRecentSuccess(symbol: string): Promise<boolean> {
  if (hasUpstash) {
    try {
      const { Redis } = await import("@upstash/redis");
      const hit = await Redis.fromEnv().get(`news-ingest-success:${symbol}`);
      if (hit !== null && hit !== undefined) return true;
    } catch (error) {
      console.error("Ingest success lookup failed, using memory:", error);
    }
  }
  const t = successMemory.get(symbol);
  return t !== undefined && Date.now() - t < SUCCESS_QUIET_S * 1000;
}

async function markIngestSuccess(symbol: string): Promise<void> {
  successMemory.set(symbol, Date.now());
  if (hasUpstash) {
    try {
      const { Redis } = await import("@upstash/redis");
      await Redis.fromEnv().set(`news-ingest-success:${symbol}`, 1, {
        ex: SUCCESS_QUIET_S,
      });
    } catch (error) {
      console.error("Ingest success marker write failed:", error);
    }
  }
}

export async function claimIngestSlot(symbol: string): Promise<boolean> {
  if (await hadRecentSuccess(symbol)) return false;
  const slot = await rateLimit("news-ingest", symbol, 1, ATTEMPT_QUIET_S);
  return slot.success;
}

export async function ingestTickerNews(
  symbol: string,
  opts?: { skipRateLimit?: boolean }
): Promise<boolean> {
  if (!hasLangflowIngest) return false;

  // Callers that already claimed the slot (scheduleNewsIngestion) skip this so
  // the claim isn't double-counted against the limit.
  if (!opts?.skipRateLimit && !(await claimIngestSlot(symbol))) return false;

  const query = `${symbol} stock latest news`;
  const apiUrl = `${LANGFLOW_BASE_URL}/api/v1/run/${LANGFLOW_INGEST_FLOW_ID}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "x-api-key": LANGFLOW_API_KEY as string,
        Authorization: `Bearer ${LANGFLOW_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input_value: query,
        output_type: "chat",
        input_type: "chat",
        tweaks: {
          [LANGFLOW_INGEST_TAVILY_ID]: { query },
          [LANGFLOW_INGEST_STRUCTURED_ID]: {
            system_prompt: ingestInstructions(symbol),
          },
        },
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      throw new Error(`ingest flow responded with ${response.status}`);
    }

    revalidateTag("news");
    await markIngestSuccess(symbol);
    return true;
  } catch (error) {
    console.error(`News ingestion failed for ${symbol}:`, error);
    return false;
  }
}

export function ingestInstructions(symbol: string): string {
  return [
    'The input contains multiple news articles separated by "---", each with',
    "TITLE, URL, and CONTENT.",
    "Extract EACH article as a separate row. Do not invent articles; only use",
    "the ones provided. For each row set:",
    `- ticker: "${symbol}"`,
    "- title: the article TITLE",
    "- url: the article URL",
    "- source: the publication name (infer from the URL/title)",
    "- sentiment: exactly Positive, Negative, or Neutral",
    "- importance: High, Medium, or Low",
    "- publication_date: YYYY-MM-DD if present, else today's date",
    "- description: one concise paragraph from CONTENT",
    "- event: a short phrase naming the event",
  ].join("\n");
}

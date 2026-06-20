import "server-only";

import { revalidateTag } from "next/cache";
import {
  hasLangflowIngest,
  LANGFLOW_API_KEY,
  LANGFLOW_BASE_URL,
  LANGFLOW_INGEST_FLOW_ID,
  LANGFLOW_INGEST_STRUCTURED_ID,
  LANGFLOW_INGEST_TAVILY_ID,
} from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";

export async function ingestTickerNews(symbol: string): Promise<boolean> {
  if (!hasLangflowIngest) return false;

  // Max 1 ingestion per ticker per 6h to avoid duplicate rows and Gemini spam.
  const slot = await rateLimit("news-ingest", symbol, 1, 6 * 60 * 60);
  if (!slot.success) return false;

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

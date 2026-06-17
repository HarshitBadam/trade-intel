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

/**
 * On-demand AI news ingestion (Langflow → Astra), shared by both the on-demand
 * path (`getNews` in details/[id]/actions.ts) and the scheduled cron warm-up
 * (api/cron/ingest). Keeping a single implementation guarantees both callers use
 * the same dedup window, tweaks and auth.
 *
 * The heavy work (Tavily search + Gemini extraction, ~15-25s) is the caller's
 * responsibility to background where appropriate: the on-demand action wraps it
 * in `after()` so it never blocks the page, while the cron route awaits it.
 *
 * Each ticker is ingested at most once per 6h window so a burst of visits — or
 * an overlap between the cron and on-demand triggers — can't spam Gemini
 * (free-tier safe) or create duplicate Astra rows.
 *
 * @returns true if the flow ran and completed; false if ingestion is disabled,
 *          the ticker was deduped, or the run failed.
 */
export async function ingestTickerNews(symbol: string): Promise<boolean> {
  if (!hasLangflowIngest) return false;

  // Per-ticker dedupe (1 attempt / 6h), keyed by ticker independent of caller.
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
        // Override the flow's defaults at call time so one flow serves every
        // ticker: point Tavily at this symbol and tag extracted rows with it.
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

    // Fresh rows are in Astra now; drop the cached (empty) news result so the
    // next read returns real data instead of the memoized miss.
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

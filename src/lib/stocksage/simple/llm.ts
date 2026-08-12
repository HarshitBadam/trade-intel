import {
  CEREBRAS_MODEL,
  GROQ_CHAT_MODEL,
  STOCKSAGE_SIMPLE_MODEL,
  STOCKSAGE_SIMPLE_PROVIDER,
} from "@/lib/config";
import {
  hasVendor,
  LlmRequestError,
  llmChatJSON,
  llmChatText,
  llmErrorSummary,
  type LlmChatArgs,
  type LlmVendor,
} from "@/lib/llm";

type SimpleLlmChatArgs = Omit<LlmChatArgs, "vendor" | "model">;

type SimpleLlmTarget = {
  vendor: LlmVendor;
  model: string;
};

const SIMPLE_PRIMARY_LLM: SimpleLlmTarget = {
  vendor: STOCKSAGE_SIMPLE_PROVIDER,
  model: STOCKSAGE_SIMPLE_MODEL,
};

const SIMPLE_FALLBACK_LLM: SimpleLlmTarget =
  STOCKSAGE_SIMPLE_PROVIDER === "groq"
    ? { vendor: "cerebras", model: CEREBRAS_MODEL }
    : { vendor: "groq", model: GROQ_CHAT_MODEL };

export function shouldFallbackSimpleLlm(error: unknown): boolean {
  if (!(error instanceof LlmRequestError)) return false;
  return (
    error.status === undefined || error.status === 429 || error.status >= 500
  );
}

async function runSimpleLlmRequest<T>(
  request: (target: SimpleLlmTarget) => Promise<T>
): Promise<T> {
  const primaryAvailable = hasVendor(SIMPLE_PRIMARY_LLM.vendor);
  const fallbackAvailable = hasVendor(SIMPLE_FALLBACK_LLM.vendor);
  if (!primaryAvailable) {
    if (fallbackAvailable) {
      console.warn(
        "[stocksage]",
        JSON.stringify({
          event: "simple_llm_fallback",
          from: SIMPLE_PRIMARY_LLM.vendor,
          to: SIMPLE_FALLBACK_LLM.vendor,
          reason: "primary_unavailable",
        })
      );
      return request(SIMPLE_FALLBACK_LLM);
    }
    throw new LlmRequestError(
      `${SIMPLE_PRIMARY_LLM.vendor} is not available for StockSage`,
      { vendor: SIMPLE_PRIMARY_LLM.vendor }
    );
  }

  try {
    return await request(SIMPLE_PRIMARY_LLM);
  } catch (error) {
    if (!fallbackAvailable || !shouldFallbackSimpleLlm(error)) throw error;
    console.warn(
      "[stocksage]",
      JSON.stringify({
        event: "simple_llm_fallback",
        from: SIMPLE_PRIMARY_LLM.vendor,
        to: SIMPLE_FALLBACK_LLM.vendor,
        ...llmErrorSummary(error),
      })
    );
    return request(SIMPLE_FALLBACK_LLM);
  }
}

export function simpleLlmChatJSON<T = unknown>(
  args: SimpleLlmChatArgs
): Promise<T> {
  return runSimpleLlmRequest((target) =>
    llmChatJSON<T>({
      ...args,
      vendor: target.vendor,
      model: target.model,
    })
  );
}

export function simpleLlmChatText(
  args: SimpleLlmChatArgs
): Promise<string> {
  return runSimpleLlmRequest((target) =>
    llmChatText({
      ...args,
      vendor: target.vendor,
      model: target.model,
    })
  );
}

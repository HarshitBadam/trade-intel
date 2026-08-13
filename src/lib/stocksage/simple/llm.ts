import {
  CEREBRAS_MODEL,
  GROQ_CHAT_MODEL,
  STOCKSAGE_MODEL,
  STOCKSAGE_PROVIDER,
} from "@/lib/config";
import {
  hasVendor,
  LlmRequestError,
  llmChatJSON,
  llmChatText,
  llmErrorSummary,
  type LlmChatArgs,
  type LlmTransportDependencies,
  type LlmVendor,
} from "@/lib/llm";

type SimpleLlmChatArgs = Omit<LlmChatArgs, "vendor" | "model">;

export type SimpleLlmDependencies = {
  vendorAvailable?: (vendor: LlmVendor) => boolean;
  transport?: LlmTransportDependencies;
};

export type SimpleLlmTarget = {
  vendor: LlmVendor;
  model: string;
};

const PRIMARY_LLM: SimpleLlmTarget = {
  vendor: STOCKSAGE_PROVIDER,
  model: STOCKSAGE_MODEL,
};

const FALLBACK_LLM: SimpleLlmTarget =
  STOCKSAGE_PROVIDER === "groq"
    ? { vendor: "cerebras", model: CEREBRAS_MODEL }
    : { vendor: "groq", model: GROQ_CHAT_MODEL };

export function shouldFallbackSimpleLlm(error: unknown): boolean {
  if (!(error instanceof LlmRequestError)) return false;
  return (
    error.status === undefined || error.status === 429 || error.status >= 500
  );
}

export async function executeSimpleLlmFallback<T>(
  primary: SimpleLlmTarget,
  fallback: SimpleLlmTarget,
  request: (target: SimpleLlmTarget) => Promise<T>,
  vendorAvailable: (vendor: LlmVendor) => boolean = hasVendor
): Promise<T> {
  const primaryAvailable = vendorAvailable(primary.vendor);
  const fallbackAvailable = vendorAvailable(fallback.vendor);
  if (!primaryAvailable) {
    if (fallbackAvailable) {
      console.warn(
        "[stocksage]",
        JSON.stringify({
          event: "simple_llm_fallback",
          from: primary.vendor,
          to: fallback.vendor,
          reason: "primary_unavailable",
        })
      );
      return request(fallback);
    }
    throw new LlmRequestError(
      `${primary.vendor} is not available for StockSage`,
      { vendor: primary.vendor }
    );
  }

  try {
    return await request(primary);
  } catch (error) {
    if (!fallbackAvailable || !shouldFallbackSimpleLlm(error)) throw error;
    console.warn(
      "[stocksage]",
      JSON.stringify({
        event: "simple_llm_fallback",
        from: primary.vendor,
        to: fallback.vendor,
        ...llmErrorSummary(error),
      })
    );
    return request(fallback);
  }
}

async function runSimpleLlmRequest<T>(
  request: (target: SimpleLlmTarget) => Promise<T>,
  vendorAvailable: (vendor: LlmVendor) => boolean = hasVendor
): Promise<T> {
  return executeSimpleLlmFallback(
    PRIMARY_LLM,
    FALLBACK_LLM,
    request,
    vendorAvailable
  );
}

export function simpleLlmChatJSON<T = unknown>(
  args: SimpleLlmChatArgs,
  dependencies: SimpleLlmDependencies = {}
): Promise<T> {
  return runSimpleLlmRequest(
    (target) =>
      llmChatJSON<T>(
        {
          ...args,
          vendor: target.vendor,
          model: target.model,
        },
        dependencies.transport
      ),
    dependencies.vendorAvailable
  );
}

export function simpleLlmChatText(
  args: SimpleLlmChatArgs,
  dependencies: SimpleLlmDependencies = {}
): Promise<string> {
  return runSimpleLlmRequest(
    (target) =>
      llmChatText(
        {
          ...args,
          vendor: target.vendor,
          model: target.model,
        },
        dependencies.transport
      ),
    dependencies.vendorAvailable
  );
}

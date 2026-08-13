import "server-only";

export const isProd = process.env.NODE_ENV === "production";

export const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const rawPolygon = Boolean(POLYGON_API_KEY);

export const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID;
export const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
export const ALPACA_FEED = process.env.ALPACA_FEED ?? "iex";
export const ALPACA_HISTORICAL_FEED = process.env.ALPACA_HISTORICAL_FEED ?? "sip";
const rawAlpaca = Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);

export const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const rawFinnhub = Boolean(FINNHUB_API_KEY);

export const ASTRA_DB_APPLICATION_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;
export const ASTRA_DB_API_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
export const ASTRA_DB_NEWS_COLLECTION =
  process.env.ASTRA_DB_NEWS_COLLECTION ?? "prototype_db_v2";
export const ASTRA_DB_ANALYSIS_COLLECTION =
  process.env.ASTRA_DB_ANALYSIS_COLLECTION ?? "stock_analysis";
const rawAstra = Boolean(
  ASTRA_DB_APPLICATION_TOKEN && ASTRA_DB_API_ENDPOINT
);

export const GROQ_API_KEY = process.env.GROQ_API_KEY;
export const GROQ_ANALYSIS_MODEL =
  process.env.GROQ_ANALYSIS_MODEL ?? "openai/gpt-oss-20b";
export const GROQ_CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ?? "qwen/qwen3.6-27b";
const rawGroq = Boolean(GROQ_API_KEY);

export const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
export const CEREBRAS_MODEL =
  process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
const rawCerebras = Boolean(CEREBRAS_API_KEY);

export type StockSageProvider = "groq" | "cerebras";

export function resolveStockSageLlmConfig(
  provider = process.env.STOCKSAGE_PROVIDER,
  model = process.env.STOCKSAGE_MODEL
): { provider: StockSageProvider; model: string } {
  const selectedProvider: StockSageProvider =
    provider?.trim().toLowerCase() === "groq" ? "groq" : "cerebras";
  return {
    provider: selectedProvider,
    model:
      model?.trim() ||
      (selectedProvider === "groq" ? GROQ_CHAT_MODEL : CEREBRAS_MODEL),
  };
}

const stockSageLlmConfig = resolveStockSageLlmConfig();
export const STOCKSAGE_PROVIDER = stockSageLlmConfig.provider;
export const STOCKSAGE_MODEL = stockSageLlmConfig.model;

export const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const rawTavily = Boolean(TAVILY_API_KEY);

export const hasAuthSecret = Boolean(
  process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
);
export const hasGoogle = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);
export const hasApple = Boolean(
  process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET
);
export const authConfigured = hasAuthSecret && (hasGoogle || hasApple);

export const enforceAuth = authConfigured;

const liveAllowed = !isProd || enforceAuth;

export const hasPolygon = rawPolygon && liveAllowed;
export const hasAlpaca = rawAlpaca && liveAllowed;
export const hasFinnhub = rawFinnhub && liveAllowed;
export const hasAstra = rawAstra && liveAllowed;
export const hasGroq = rawGroq && liveAllowed;
export const hasCerebras = rawCerebras && liveAllowed;
export const hasTavily = rawTavily && liveAllowed;

if (
  isProd &&
  (rawPolygon ||
    rawAlpaca ||
    rawFinnhub ||
    rawAstra ||
    rawGroq ||
    rawCerebras ||
    rawTavily) &&
  !enforceAuth
) {
  console.error(
    "[TradeIntel] SECURITY: Provider keys are set in production but authentication " +
      "is NOT enforced (missing AUTH_SECRET and/or Google/Apple credentials). " +
      "Live API calls are DISABLED (serving mock data) to prevent unauthenticated " +
      "cost. Configure auth to enable live data."
  );
}

export const QSTASH_URL = process.env.QSTASH_URL;
export const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
export const QSTASH_CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY;
export const QSTASH_NEXT_SIGNING_KEY = process.env.QSTASH_NEXT_SIGNING_KEY;
export const APP_URL =
  process.env.APP_URL ?? process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
export const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
export const MARKET_INTELLIGENCE_ON_DEMAND_DAILY_BUDGET = Math.max(
  1,
  Number(process.env.MARKET_INTELLIGENCE_ON_DEMAND_DAILY_BUDGET ?? 300)
);
export const MARKET_INTELLIGENCE_USER_DAILY_LIMIT = Math.max(
  1,
  Number(process.env.MARKET_INTELLIGENCE_USER_DAILY_LIMIT ?? 20)
);
export const MARKET_INTELLIGENCE_USER_BURST_LIMIT = Math.max(
  1,
  Number(process.env.MARKET_INTELLIGENCE_USER_BURST_LIMIT ?? 10)
);

import "server-only";

export const isProd = process.env.NODE_ENV === "production";

export const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const rawPolygon = Boolean(POLYGON_API_KEY);

export const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID;
export const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
// Free plan only permits IEX for snapshots (SIP requires Algo Trader Plus).
export const ALPACA_FEED = process.env.ALPACA_FEED ?? "iex";
// IEX covers ~2.5% of US volume; SIP (100%) is free on Basic for bars >=15 min old.
// Set to "iex" only if the account lacks SIP historical access.
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

export const LANGFLOW_BASE_URL = process.env.LANGFLOW_BASE_URL;
export const LANGFLOW_FLOW_ID = process.env.LANGFLOW_FLOW_ID;
export const LANGFLOW_API_KEY = process.env.LANGFLOW_API_KEY;
const rawLangflow = Boolean(
  LANGFLOW_BASE_URL && LANGFLOW_FLOW_ID && LANGFLOW_API_KEY
);

export const LANGFLOW_CHAT_PROMPT_ID =
  process.env.LANGFLOW_CHAT_PROMPT_ID ?? "StockSageRagPrompt-FwmYE";

export const LANGFLOW_CHAT_LLM_ID =
  process.env.LANGFLOW_CHAT_LLM_ID ?? "GroqModel-chat1";

export const LANGFLOW_ANALYZE_FLOW_ID = process.env.LANGFLOW_ANALYZE_FLOW_ID;
const rawLangflowAnalyze = Boolean(
  LANGFLOW_BASE_URL && LANGFLOW_API_KEY && LANGFLOW_ANALYZE_FLOW_ID
);

// Two models share one Groq account so each gets its own per-model daily bucket:
// 8B (14,400 RPD) for batch analysis; 70B (1,000 RPD) for interactive chat.
export const GROQ_API_KEY = process.env.GROQ_API_KEY;
export const GROQ_ANALYSIS_MODEL =
  process.env.GROQ_ANALYSIS_MODEL ?? "llama-3.1-8b-instant";
export const GROQ_CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ?? "llama-3.3-70b-versatile";
const rawGroq = Boolean(GROQ_API_KEY);

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
export const hasLangflow = rawLangflow && liveAllowed;
export const hasLangflowAnalyze = rawLangflowAnalyze && liveAllowed;
export const hasTavily = rawTavily && liveAllowed;
export const STOCKSAGE_DEEP_SNAPSHOT_SECRET =
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET ??
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET;
export const hasDeepResearch = Boolean(
  hasLangflow && STOCKSAGE_DEEP_SNAPSHOT_SECRET
);

if (
  isProd &&
  (rawPolygon ||
    rawAlpaca ||
    rawFinnhub ||
    rawAstra ||
    rawGroq ||
    rawLangflow ||
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

export const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

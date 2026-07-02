import "server-only";

export const isProd = process.env.NODE_ENV === "production";

export const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const rawPolygon = Boolean(POLYGON_API_KEY);

export const ASTRA_DB_APPLICATION_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;
export const ASTRA_DB_API_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
export const ASTRA_DB_NEWS_COLLECTION =
  process.env.ASTRA_DB_NEWS_COLLECTION ?? "prototype_db_v2";
const rawAstra = Boolean(
  ASTRA_DB_APPLICATION_TOKEN && ASTRA_DB_API_ENDPOINT
);

export const LANGFLOW_BASE_URL = process.env.LANGFLOW_BASE_URL;
export const LANGFLOW_FLOW_ID = process.env.LANGFLOW_FLOW_ID;
export const LANGFLOW_API_KEY = process.env.LANGFLOW_API_KEY;
const rawLangflow = Boolean(
  LANGFLOW_BASE_URL && LANGFLOW_FLOW_ID && LANGFLOW_API_KEY
);

// Langflow regenerates node-ID suffixes on every import; app resolves live IDs
// by stable prefix at runtime (see resolveChatNodeIds in actions.ts). These are
// only fallbacks for the current hosted instance — override via env if rebuilt.
// Fallback node IDs, used only if the live flow-fetch in resolveChatNodeIds
// can't run. Kept in sync with langflow/stocksage-chat.json so even the fallback
// path targets the right nodes when the hosted flow preserved the imported IDs.
export const LANGFLOW_CHAT_PROMPT_ID =
  process.env.LANGFLOW_CHAT_PROMPT_ID ?? "StockSageRagPrompt-FwmYE";

export const LANGFLOW_CHAT_LLM_ID =
  process.env.LANGFLOW_CHAT_LLM_ID ?? "LanguageModelComponent-0ZJmW";

export const LANGFLOW_INGEST_FLOW_ID = process.env.LANGFLOW_INGEST_FLOW_ID;
export const LANGFLOW_INGEST_TAVILY_ID =
  process.env.LANGFLOW_INGEST_TAVILY_ID ?? "TavilySearchComponent-LyDPQ";
export const LANGFLOW_INGEST_STRUCTURED_ID =
  process.env.LANGFLOW_INGEST_STRUCTURED_ID ?? "StructuredOutput-oUGso";

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

// Secure-by-default: production enforces auth when configured; dev stays open
// so the demo runs with zero config (expensive actions are still rate-limited).
export const enforceAuth = authConfigured;

// Live API calls only allowed when auth is enforced in prod — prevents an
// unauthenticated production deploy from incurring cost.
const liveAllowed = !isProd || enforceAuth;

export const hasPolygon = rawPolygon && liveAllowed;
export const hasAstra = rawAstra && liveAllowed;
export const hasLangflow = rawLangflow && liveAllowed;
export const hasLangflowIngest =
  Boolean(LANGFLOW_BASE_URL && LANGFLOW_INGEST_FLOW_ID && LANGFLOW_API_KEY) &&
  liveAllowed;

if (isProd && (rawPolygon || rawAstra || rawLangflow) && !enforceAuth) {
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

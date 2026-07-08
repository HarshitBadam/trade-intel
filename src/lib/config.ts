import "server-only";

export const isProd = process.env.NODE_ENV === "production";

export const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const rawPolygon = Boolean(POLYGON_API_KEY);

// Alpaca Market Data — the PREFERRED source for all price/volume data (candles,
// intraday, snapshots). Free tier ~200 req/min, so it never competes with
// Polygon's 5/min budget (now reserved for news+sentiment).
export const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID;
export const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
// Snapshot / "latest" feed. The free plan ONLY permits IEX here (SIP snapshots
// 403 without Algo Trader Plus), so this stays "iex". Snapshots give real-time
// price + day change (both accurate on IEX — the last-trade price matches SIP);
// only their VOLUME is the ~2.5% IEX slice, which we correct via SIP daily bars.
export const ALPACA_FEED = process.env.ALPACA_FEED ?? "iex";
// Historical bars feed. IEX sees only ~2.5% of US volume, so trade counts and
// share volume came out 10-30x too low. SIP (100% of volume) is FREE on the
// Basic plan for any window ending >=15 min ago — see alpaca.ts for the clamp.
// Defaults to "sip"; set to "iex" to force the (undercounted but real-time)
// single-exchange feed if an account somehow lacks SIP historical access.
export const ALPACA_HISTORICAL_FEED = process.env.ALPACA_HISTORICAL_FEED ?? "sip";
const rawAlpaca = Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);

// Finnhub — the PREFERRED source for non-price metadata (symbol search, company
// profile, peers). Free tier ~60 req/min.
export const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const rawFinnhub = Boolean(FINNHUB_API_KEY);

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

export const enforceAuth = authConfigured;

const liveAllowed = !isProd || enforceAuth;

export const hasPolygon = rawPolygon && liveAllowed;
export const hasAlpaca = rawAlpaca && liveAllowed;
export const hasFinnhub = rawFinnhub && liveAllowed;
export const hasAstra = rawAstra && liveAllowed;
export const hasLangflow = rawLangflow && liveAllowed;
export const hasLangflowIngest =
  Boolean(LANGFLOW_BASE_URL && LANGFLOW_INGEST_FLOW_ID && LANGFLOW_API_KEY) &&
  liveAllowed;

if (
  isProd &&
  (rawPolygon || rawAlpaca || rawFinnhub || rawAstra || rawLangflow) &&
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

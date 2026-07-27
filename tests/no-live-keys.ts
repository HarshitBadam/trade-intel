// src/lib/config.ts snapshots process.env into module-scope constants, so this
// must be the first import in every test file: once config.ts is evaluated the
// has* gates are frozen and deleting keys later has no effect.
for (const key of [
  "POLYGON_API_KEY",
  "ALPACA_API_KEY_ID",
  "ALPACA_API_SECRET_KEY",
  "ALPACA_FEED",
  "ALPACA_HISTORICAL_FEED",
  "FINNHUB_API_KEY",

  "ASTRA_DB_APPLICATION_TOKEN",
  "ASTRA_DB_API_ENDPOINT",
  "ASTRA_DB_NEWS_COLLECTION",
  "ASTRA_DB_ANALYSIS_COLLECTION",

  "LANGFLOW_BASE_URL",
  "LANGFLOW_FLOW_ID",
  "LANGFLOW_API_KEY",
  "LANGFLOW_ANALYZE_FLOW_ID",
  "LANGFLOW_CHAT_PROMPT_ID",
  "LANGFLOW_CHAT_LLM_ID",

  "GROQ_API_KEY",
  "GROQ_ANALYSIS_MODEL",
  "GROQ_CHAT_MODEL",
  "GROQ_FALLBACK_MODEL",
  "GROQ_OSS_MODEL",
  "CEREBRAS_API_KEY",
  "CEREBRAS_CHAT_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_CHAT_MODEL",
  "TAVILY_API_KEY",

  // Auth presence feeds liveAllowed and STOCKSAGE_DEEP_SNAPSHOT_SECRET, which
  // gate the deep-research routes.
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_APPLE_ID",
  "AUTH_APPLE_SECRET",
  "STOCKSAGE_DEEP_SNAPSHOT_SECRET",

  // Without these the breaker and deep-work stores stay in memory, so the
  // resetBreakerMemory/resetDeepWorkMemory helpers actually clear the store
  // the code under test reads.
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
]) {
  delete process.env[key];
}

export {};

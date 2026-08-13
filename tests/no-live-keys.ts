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

  "GROQ_API_KEY",
  "GROQ_ANALYSIS_MODEL",
  "GROQ_CHAT_MODEL",
  "CEREBRAS_API_KEY",
  "CEREBRAS_MODEL",
  "STOCKSAGE_PROVIDER",
  "STOCKSAGE_MODEL",
  "TAVILY_API_KEY",

  // Auth presence feeds liveAllowed, which gates live provider access.
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_APPLE_ID",
  "AUTH_APPLE_SECRET",

  // Without these the breaker and rate-limit stores stay in memory.
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
]) {
  delete process.env[key];
}

export {};

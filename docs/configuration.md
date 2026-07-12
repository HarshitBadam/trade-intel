# Configuration

Everything is configured through environment variables. `.env.example` documents each one inline and is the source of truth; this page is the map.

## Run modes

- **Mock mode (default).** With an empty `.env.local`, every feature runs on generated data. Good for a quick look or for UI work without any accounts.
- **Live mode.** Add a provider's keys and that feature switches to real data. Pieces are independent, so you can run live prices without setting up auth, or news without chat.

## Variable groups

| Group | Variables | Purpose |
|-------|-----------|---------|
| Auth | `AUTH_SECRET`, `AUTH_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google sign-in. Optional locally. |
| Market data | `ALPACA_*`, `FINNHUB_API_KEY`, `POLYGON_API_KEY` | Prices, metadata, news. |
| Store | `ASTRA_DB_*` | Analyzed news and verdicts. |
| AI and retrieval | `GROQ_*`, `TAVILY_API_KEY`, `LANGFLOW_*`, `STOCKSAGE_DEEP_SNAPSHOT_SECRET` | Regular/deeper chat synthesis and web context, plus optional Langflow batch analysis. The optional dedicated snapshot secret falls back to `AUTH_SECRET` or `NEXTAUTH_SECRET`. |
| Ops | `UPSTASH_REDIS_*`, `CRON_SECRET`, `CRON_BATCH_SIZE`, `CRON_MAX_ANALYSES` | Rate limiting, the breaker, the ingest cron. |

## The production safety rule

`src/lib/config.ts` derives feature flags from which keys are present. In production, if the market or AI keys are set but auth is not configured, the app disables every live provider and serves mock data instead. That stops an unauthenticated public URL from spending API quota. Outside production the providers stay on, so you can develop against real data without wiring up auth first.

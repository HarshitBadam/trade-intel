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
| AI and retrieval | `GROQ_*`, `TAVILY_API_KEY`, `STOCKSAGE_DEEP_SNAPSHOT_SECRET`; optional manual `LANGFLOW_BASE_URL`, `LANGFLOW_API_KEY`, `LANGFLOW_ANALYZE_FLOW_ID` | Regular/deeper synthesis calls Groq directly; retrieval is cache-first and fills only uncovered cells. Langflow is manual analysis evaluation only. The snapshot secret falls back to `AUTH_SECRET` or `NEXTAUTH_SECRET`. |
| Chat safety | `GROQ_SAFETY_MODEL`, `STOCKSAGE_SAFETY_CLASSIFIER` | The custom-policy safeguard input rail. Both optional. |
| Ops | `UPSTASH_REDIS_*`, `QSTASH_*`, `APP_URL`, `CRON_SECRET`, `MARKET_INTELLIGENCE_*` | Rate limiting, durable refresh jobs, signed workers, showcase/maintenance schedules, and on-demand budgets. |

## The chat safety rail

The model half of the safety rail rides on the Groq key: set `GROQ_API_KEY` and chat input is also scored by the custom-policy safeguard (`GROQ_SAFETY_MODEL`, default `openai/gpt-oss-safeguard-20b`) alongside the deterministic crisis and violence prefilter. There is nothing extra to configure.

Two escape hatches:

- `GROQ_SAFETY_MODEL` points the rail at a different guard model.
- `STOCKSAGE_SAFETY_CLASSIFIER=off` disables the rail while leaving Groq synthesis alone, for when the classifier is misbehaving on real traffic. The regex prefilter keeps running either way.

With no Groq key the rail is simply absent, exactly as if it had timed out. See [architecture.md](architecture.md) for the layering.

## The production safety rule

`src/lib/config.ts` derives feature flags from which keys are present. In production, if the market or AI keys are set but auth is not configured, the app disables every live provider and serves mock data instead. That stops an unauthenticated public URL from spending API quota. Outside production the providers stay on, so you can develop against real data without wiring up auth first.

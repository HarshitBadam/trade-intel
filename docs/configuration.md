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
| StockSage AI | `STOCKSAGE_SIMPLE_PROVIDER`, `STOCKSAGE_SIMPLE_MODEL`, `GROQ_API_KEY`, `GROQ_CHAT_MODEL`, `CEREBRAS_API_KEY`, `CEREBRAS_MODEL` | Selects the primary chat provider/model. When both providers are configured, transient failures fail over automatically. |
| Retrieval | `TAVILY_API_KEY`, `ASTRA_DB_*`, market-data keys | Focused web news, published market intelligence, prices, and US rankings. |
| Ops | `UPSTASH_REDIS_*`, `QSTASH_*`, `APP_URL`, `CRON_SECRET`, `MARKET_INTELLIGENCE_*` | Rate limiting, durable refresh jobs, signed workers, showcase/maintenance schedules, and on-demand budgets. `APP_URL` resolves as `APP_URL`, then `AUTH_URL`, then legacy `NEXTAUTH_URL`. |

StockSage always applies the deterministic crisis and finance-domain policy
checks in `stocksage/policy/crisis.ts` and `stocksage/policy/index.ts`; they
require no separate configuration.

## The production safety rule

`src/lib/config.ts` derives feature flags from which keys are present. In production, if the market or AI keys are set but auth is not configured, the app disables every live provider and serves mock data instead. That stops an unauthenticated public URL from spending API quota. Outside production the providers stay on, so you can develop against real data without wiring up auth first.

# Langflow evolution

TradeIntel initially used Langflow hosted on Hugging Face for news ingestion, chat, and stock analysis. Production evidence showed that it was not suitable as a critical runtime dependency, so analysis moved to direct Groq and orchestration moved to durable, idempotent QStash jobs with content-addressed reuse and last-known-good delivery.

The preserved flows document how the project explored ingestion, retrieval-augmented chat, and analysis through visual orchestration before consolidating those responsibilities into the production architecture.

## Preserved flows

### `stocksage-ingestion.json`

Combined Tavily search, article cleaning, structured LLM extraction, and Astra DB storage. It was retired when the store-first pipeline took ownership of ingestion, stable article identities, provider fallbacks, and retention.

### `stocksage-chat.json`

Combined Astra retrieval, live web evidence, prompting, Groq synthesis, and chat output. It was retired as StockSage evolved into a typed engine with deterministic safety rules, conversation context, evidence planning, citation validation, latency budgets, and asynchronous Deep Research.

### `stocksage-analysis.json`

Separated per-ticker analysis from ingestion and supported the later Langflow-first analysis path. It was replaced by a worker that fingerprints its inputs, calls direct Groq only when the underlying content changes, validates the response, and atomically publishes the result.

## Current architecture

The application now serves stored market intelligence immediately and publishes stale or missing work to a signed background queue. Showcase tickers are refreshed hourly; other tickers are refreshed on demand. Failed provider or model work never removes the last usable result.

Langflow is no longer part of the runtime, deployment, environment configuration, or release infrastructure. These exports are retained only as historical artifacts. Intermediate revisions remain available in Git history.

The exports contain no embedded credentials. Historical Astra resource identifiers were replaced with placeholders. Importing them into a current Langflow release may require component migration and fresh provider configuration.

See the [current architecture](../docs/architecture.md) and the [architecture redesign record](../docs/architecture-redesign.md) for the implemented system and full decision history.
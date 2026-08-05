# Stack

Grouped by role. The choices that actually shape the app are explained in [architecture.md](architecture.md); this is the inventory.

## Framework

- **Next.js 15** (App Router, React Server Components) and **React 19**. Pages render on the server and read through a cached data layer, so most of the app ships no client JavaScript.
- **TypeScript** everywhere.
- **Tailwind CSS 4** with a small set of shadcn-style UI primitives (`src/components/ui`).

## Data providers

- **Alpaca** for prices, candles, and snapshots. Fast and reliable on the free tier, so it is the one provider the request path calls live.
- **Finnhub** for company profiles, peers, and the search fallback.
- **Polygon** for bulk news and its free per-article sentiment, fetched by the cron rather than at request time.

## Store and infrastructure

- **Astra DB** (DataStax) holds analyzed articles and per-ticker verdicts. It is the store the request path reads from.
- **Upstash Redis** backs rate limiting, isolated circuit breakers, the cron cursor, and deeper-research idempotency. It is HTTP-based, so it works from serverless functions and shares state across instances.
- **Vercel** hosts the app; **GitHub Actions** runs the ingestion cron.

## AI

- **Groq** runs isolated model lanes: 8B batch analysis, 70B primary chat, and GPT OSS/8B chat failover.
- **Tavily** supplies only explicitly planned, filtered evidence for current and comparison routes.
- **Langflow** is retained only as an explicit manual analysis-evaluation adapter; production analysis and StockSage call Groq directly.
- **Auth.js** handles Google sign-in.

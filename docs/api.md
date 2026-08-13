# API reference

The app has almost no public HTTP surface. Pages are React Server Components, and the browser talks to the server through Next.js server actions rather than a REST API. Both are listed below.

## HTTP routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET, POST | `/api/auth/[...nextauth]` | OAuth handshake | Auth.js sign-in and callbacks |
| GET | `/api/cron/showcase` | `Bearer <CRON_SECRET>` | Publishes the ten paced showcase refresh jobs |
| GET | `/api/cron/maintenance` | `Bearer <CRON_SECRET>` | Prunes retained articles older than 90 days |
| POST | `/api/market-intelligence/worker` | QStash signature | Runs one idempotent ticker refresh |
| POST | `/api/market-intelligence/worker/failure` | QStash signature | Finalizes terminal delivery failure |

Cron routes reject an incorrect bearer token. Worker routes are reachable
through middleware but reject any request whose QStash signature does not
verify.

## Server actions

These are called directly from client components. Each one that touches a provider runs through `guard()`, which rate limits by signed-in user id or, for anonymous traffic, a hashed client IP, on a sliding window.

**Chat** (`src/app/actions.ts`)

| Action | Limit | Returns |
|--------|-------|---------|
| `getSummary({ message, sessionId?, history, state? })` | 24 / min | Answer, citations, resolved v1 state, presentation metadata, and response id |

`getSummary` validates bounded history and v1 state, enforces the deterministic
crisis and finance-domain policy floor, resolves references and groups, then
runs the simple extraction, parallel retrieval, and evidence-bound composition
pipeline. Social and policy responses return without retrieval.

**Stock data** (`src/app/details/[id]/actions.ts`)

| Action | Limit | Returns |
|--------|-------|---------|
| `searchStocks(query)` | 60 / min (Finnhub path only) | `{ stocks, searchUnavailable? }` |
| `fetchDetails(ticker)` | 30 / min | Store-only `StockData` snapshot |
| `requestDetailsRefresh(ticker)` | 10 / min plus daily admission | Reserve or join one durable refresh job |
| `pollDetailsRefresh(workId)` | 120 / min | Durable queued/running/done/failed state |
| `getLiveQuotes(tickers)` | none | `LiveQuote[]` for a small set |
| `fetchChartRange(ticker, kind)` | 30 / min | `BarPoint[]` for a range |
| `fetchHomeTicker(ticker)` | 30 / min | `{ quote, headline }` for a home chip switch |

Local search does not count against the limit. `searchStocks` only calls `guard()` when a query misses the local universe and falls through to Finnhub.

## Return shapes

Types live in `src/lib/market-data/types.ts` and the page components. The two that show up most:

```ts
type NewsStatus =
  | "fresh"
  | "stale"
  | "degraded"
  | "hard_expired"
  | "no_news"
  | "analysis_unavailable"
  | "unavailable"
  | "sample";

type PriceStatus = "live" | "sample" | "unavailable";
```

A `sample` status anywhere means the app is on mock data, which is what an empty `.env.local` gives you.

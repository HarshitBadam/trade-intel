# API reference

The app has almost no public HTTP surface. Pages are React Server Components, and the browser talks to the server through Next.js server actions rather than a REST API. Both are listed below.

## HTTP routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET, POST | `/api/auth/[...nextauth]` | OAuth handshake | Auth.js sign-in and callbacks |
| GET | `/api/cron/news` | `Bearer <CRON_SECRET>` | Runs one ingestion pass, returns a JSON report. See [data-pipeline.md](data-pipeline.md) |

A request to `/api/cron/news` without the right bearer token gets a 401.

## Server actions

These are called directly from client components. Each one that touches a provider runs through `guard()`, which rate limits by signed-in user id or, for anonymous traffic, a hashed client IP, on a sliding window.

**Chat** (`src/app/actions.ts`)

| Action | Limit | Returns |
|--------|-------|---------|
| `warmStockSage()` | none | void. Pings the Langflow host so the first message is not cold |
| `getSummary(message, sessionId?, history?)` | 10 / min | `{ text, live, retryable? }`, the reply as markdown |

`getSummary` grounds the model with live quotes for any tickers it finds in the message, the recent conversation, and today's date, then answers through Langflow or the Groq fallback.

**Stock data** (`src/app/details/[id]/actions.ts`)

| Action | Limit | Returns |
|--------|-------|---------|
| `searchStocks(query)` | 60 / min (Finnhub path only) | `{ stocks, searchUnavailable? }` |
| `fetchDetails(ticker)` | 30 / min | `StockData` |
| `fetchQuote(ticker)` | 30 / min | latest `Quote` |
| `fetchTopHeadline(ticker)` | 30 / min | lead `Headline` |
| `fetchMovers()` | 30 / min | gainers, losers, sentiment shifts |
| `getLiveQuotes(tickers)` | none | `LiveQuote[]` for a small set |
| `fetchRelatedStocks(ticker)` | 30 / min | `RelatedCard[]` peer list |
| `fetchChartRange(ticker, kind)` | 30 / min | `BarPoint[]` for a range |
| `fetchHomeTicker(ticker)` | 30 / min | `{ quote, headline }` for a home chip switch |

Local search does not count against the limit. `searchStocks` only calls `guard()` when a query misses the local universe and falls through to Finnhub.

## Return shapes

Types live in `src/lib/market-data/types.ts` and the page components. The two that show up most:

```ts
type NewsStatus =
  | "fresh"        // analyzed within the last 3 days
  | "stale"        // analyzed, but older than that
  | "live"         // articles present, not yet analyzed
  | "analyzing"    // a priority analysis is running
  | "unavailable"  // nothing stored and no source reached it
  | "sample";      // mock data (no keys configured)

type PriceStatus = "live" | "sample" | "unavailable";
```

A `sample` status anywhere means the app is on mock data, which is what an empty `.env.local` gives you.

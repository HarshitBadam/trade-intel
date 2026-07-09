# Architecture

The design follows one rule: the request path only reads, and background jobs do the slow writing. This page covers the read path, how providers are split, caching, failure handling, and auth. The write path has its own page in [data-pipeline.md](data-pipeline.md).

## Why it's built this way

The free tiers are the constraint. Polygon news is 5 requests a minute. The Langflow host sleeps when idle and occasionally returns 503 for hours until someone restarts it. An early version called these providers on every page load, so a burst of clicks would exhaust the news budget and leave the UI stuck on "analyzing" or "unavailable".

Moving that work into a scheduled job fixes it. The cron owns the scarce providers and fills a database. Pages read the database plus Alpaca, which is fast (200 req/min) and reliable. When an upstream provider goes down, the cron retries on its next run and pages keep serving whatever is already stored.

## System overview

```mermaid
flowchart TB
  subgraph client["Browser"]
    HOME["Home /"]
    DETAIL["Details /details/:id"]
    CHAT["StockSage chat"]
  end

  subgraph next["Next.js (Vercel)"]
    RSC["Server Components + actions"]
    CACHE["unstable_cache layer"]
    CRON["/api/cron/news"]
  end

  subgraph store["Store of record"]
    ASTRA[(Astra DB<br/>news + verdicts)]
    REDIS[(Upstash Redis<br/>limits + breaker)]
  end

  subgraph providers["External providers"]
    ALPACA["Alpaca (prices)"]
    FINNHUB["Finnhub (metadata)"]
    POLYGON["Polygon (news)"]
    GROQ["Groq (LLM)"]
    LANGFLOW["Langflow host"]
  end

  HOME --> RSC
  DETAIL --> RSC
  CHAT --> RSC
  RSC --> CACHE
  CACHE --> ASTRA
  CACHE --> ALPACA
  CACHE --> FINNHUB
  RSC --> REDIS
  CHAT --> LANGFLOW
  CHAT -.fallback.-> GROQ

  CRON --> POLYGON
  CRON --> GROQ
  CRON --> LANGFLOW
  CRON --> ASTRA
```

Read-path providers are Astra, Alpaca, and Finnhub. Polygon and the LLMs sit on the cron side. The one exception is the chat assistant, which is interactive by nature and calls Langflow (or Groq) live.

## Serving a page

A request never fans out to a rate-limited provider. It reads the store and Alpaca, both fronted by `unstable_cache`.

```mermaid
sequenceDiagram
  participant B as Browser
  participant P as page.tsx
  participant Q as market-data/queries.ts
  participant C as unstable_cache
  participant A as Alpaca
  participant D as Astra

  B->>P: GET /details/AAPL
  P->>Q: getDetailsData("AAPL")
  par prices
    Q->>C: getCandlesCached
    C->>A: bars (on cache miss)
  and stored news
    Q->>C: readStoredArticlesCached
    Q->>C: readAnalysisDocCached
    C->>D: articles + verdict (on cache miss)
  end
  Q-->>P: StockData
  P-->>B: rendered page
```

> If Astra has nothing for a ticker (a long-tail name the cron has not reached), the detail page kicks off a one-off priority analysis in the background, shows an "analyzing" badge, and polls until it lands (rate limited and single-flighted). It is the one spot where the request path triggers live analysis.

## Provider split

| Provider | Role | Where it runs |
|----------|------|---------------|
| Alpaca | Prices, candles, snapshots, movers | Read path |
| Finnhub | Company profile, peers, symbol search fallback | Read path |
| Polygon | Bulk news and per-article interim sentiment | Cron only |
| Astra DB | Stored articles and per-ticker verdicts | Both |
| Groq | Batch analysis (8B) and chat (70B) | Cron and chat |
| Langflow | Orchestrates the Groq calls | Cron and chat |

Prices resolve in order: Alpaca SIP history with a live IEX tail, then Polygon aggregates as a backup, then nothing. In live mode the UI shows an "unavailable" state rather than inventing a price.

## Search

Search hits a local index first. `src/data/universe.json` holds about 12,500 US tickers built from Alpaca's asset list, and `searchUniverse()` scans it in memory with a five-bucket score: exact symbol, symbol prefix, symbol substring, name prefix, name substring. Nothing in the universe touches the network. Finnhub is the only live fallback, for fuzzy company-name queries that miss locally.

## Caching

Reads go through `unstable_cache` with tag-based revalidation. The cron calls `revalidateTag("news")` after it writes, so fresh sentiment shows up without waiting for a timer.

| Data | Revalidate | Tag |
|------|-----------:|-----|
| Daily candles | 300s | `candles` |
| Intraday / fine candles | 300s | `candles` |
| Market movers map | 3600s | `movers` |
| Year-ago closes | 86400s | `movers` |
| Ticker detail / peers | 86400s | `fundamentals` |
| Symbol search | 86400s | `search` |
| Stored articles / verdict | 600s | `news` |

## Failure handling

Two mechanisms keep a flaky provider from becoming a broken page.

**Circuit breaker** (`src/lib/breaker.ts`) tracks Polygon, Groq, and Langflow. Three failures inside ten minutes opens the circuit; callers then skip that provider and take the fallback path. State lives in Redis so it is shared across serverless instances, with an in-process map as the local fallback.

**Sliding rate limiter** (`src/lib/market-data/limiter.ts`) smooths outgoing bursts to each provider (Alpaca 180/min, Finnhub 50/min). It never rejects, it delays. Callers just `await acquire()`.

## Auth and user limits

Auth.js handles Google OAuth with JWT sessions (`src/auth.ts`, `src/auth.config.ts`, `src/middleware.ts`). Auth turns on only when `AUTH_SECRET` and a provider are configured; otherwise the app runs open in demo mode. When it is on, `/login` and the auth callbacks are the only public routes.

Every server action runs through `guard()` (`src/lib/guard.ts`), which rate limits per identity: the signed-in user id, or a hashed client IP when anonymous. Per-action limits are in [api.md](api.md).

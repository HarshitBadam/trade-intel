# Repo structure

The source tree, annotated. Config and generated files are omitted.

```
.
├── .github/workflows/
│   └── ci.yml                   # typecheck, lint, tests, and production build
├── scripts/
│   ├── env.ts                    # shared .env.local loader for standalone tools
│   ├── build-universe.mjs       # rebuilds universe.json from Alpaca's asset list
│   ├── run-showcase-cron.ts     # invokes the showcase scheduler manually
│   ├── load-news.ts             # loads news for a single ticker
│   ├── analyze-ticker.ts        # analyzes a single ticker
│   ├── setup-qstash.ts          # reconciles showcase + maintenance schedules
│   ├── stocksage-smoke.ts       # runs the StockSage smoke scenarios
│   ├── stocksage-simple-eval.ts # runs the live StockSage evaluation set
│   └── asx-parity-benchmark.ts  # compares AU and US simple-runtime coverage
├── docs/
│   ├── screenshots.md
│   ├── stack.md
│   ├── architecture.md
│   ├── data-pipeline.md
│   ├── api.md
│   ├── configuration.md
│   ├── deployment.md
│   └── repo-structure.md
└── src/
    ├── middleware.ts            # wraps auth when configured, passthrough otherwise
    ├── auth.ts                  # NextAuth instance (handlers, auth, signIn)
    ├── auth.config.ts           # providers, session strategy, authorized callback
    ├── app/
    │   ├── layout.tsx           # root shell, fonts, theme bootstrap, nav
    │   ├── page.tsx             # home, server-renders the default ticker
    │   ├── HomeView.tsx         # home client UI (search, chips, chart, movers, news)
    │   ├── actions.ts           # validated chat server action
    │   ├── globals.css          # imports the style layers in src/styles
    │   ├── error.tsx            # error boundary page
    │   ├── not-found.tsx        # 404 page
    │   ├── login/page.tsx       # sign-in screen
    │   ├── api/
    │   │   ├── auth/[...nextauth]/route.ts  # Auth.js route handlers
    │   │   ├── cron/showcase/route.ts       # publishes paced showcase jobs
    │   │   ├── cron/maintenance/route.ts    # article-retention maintenance
    │   │   └── market-intelligence/worker/  # signed work + failure routes
    │   └── details/[id]/
    │       ├── page.tsx         # detail route, assembles StockData server-side
    │       ├── DetailsView.tsx  # detail UI, durable refresh status polling
    │       ├── RelatedStocksSection.tsx # eager independent streamed peers
    │       ├── actions.ts       # detail reads, refresh enqueue/status, charts
    │       └── loading.tsx      # skeleton while the page streams
    ├── components/
    │   ├── layout/              # Nav, HeaderGate, SearchBar, breadcrumb, theme toggle, user menu
    │   ├── charts/              # MainChart, StockGraph, PopularityGraph, grid/range helpers
    │   ├── chat/                # FloatingWidget, ChatMessage, and the StockSage chat surface
    │   ├── news/                # NewsCard, NewsModal, TopNews, RecentInfluential, Bar
    │   ├── stocks/              # Overview, StockChips, TopGainer
    │   ├── shared/              # FlipCard, SentimentLabel
    │   ├── login/               # LoginForm, Guilloche background, BrandMarquee
    │   ├── error/               # ErrorScene
    │   ├── legal/               # LegalModal (disclaimer)
    │   └── ui/                  # shared button, card, chart, menu, and progress primitives
    ├── lib/
    │   ├── config.ts            # feature flags derived from which env keys exist
    │   ├── market-calendar.ts   # shared US/AU sessions, holidays, and interval types
    │   ├── breaker.ts           # isolated provider and workload breakers
    │   ├── rate-limit.ts        # Upstash sliding-window limiter
    │   ├── guard.ts             # per-action, per-identity rate guard
    │   ├── groq.ts              # groqChatJSON / groqChatText transport
    │   ├── llm-json.ts          # fenced-JSON parsing for LLM output
    │   ├── auth-actions.ts      # sign-in / sign-out server actions
    │   ├── movers.ts            # market movers helpers
    │   ├── prefetch.ts          # hover/route prefetch helpers
    │   ├── tickers.ts           # ticker resolution from free text
    │   ├── telemetry.ts         # structured StockSage and market-data events
    │   ├── useStaleData.ts      # stale-while-revalidate client hook
    │   ├── utils.ts             # cn() and small shared helpers
    │   ├── stocksage/
    │   │   ├── chat.ts          # stable wrapper for the simple runtime
    │   │   ├── simple-runtime.ts # compatibility facade for the simple pipeline
    │   │   ├── simple/           # extraction, retrieval, composition, and orchestration
    │   │   ├── conversation-*.ts # focused entity, group, correction, and reference state transitions
    │   │   ├── temporal.ts       # public temporal facade
    │   │   ├── temporal-*.ts     # calendar, parsing, interval, and state helpers
    │   │   ├── evidence/astra.ts # published market-intelligence evidence reader
    │   │   ├── policy.ts        # finance-domain and misuse policy
    │   │   ├── crisis.ts        # zero-cost crisis-language prefilter
    │   │   ├── state.ts         # untrusted state canonicalization
    │   │   ├── conversation-attributes.ts # criteria, horizon, and jurisdiction detection
    │   │   ├── citations.ts     # source-ID validation and safe link expansion
    │   │   ├── entity-catalog.ts # aliases, groups, and non-US listings
    │   │   ├── entity-resolution.ts # canonical ticker/group resolution
    │   │   ├── tavily.ts        # bounded server-side Tavily fetch wrapper
    │   │   └── types.ts         # validated chat contracts
    │   ├── market-intelligence/
    │   │   ├── worker.ts / refresh-*.ts # refresh orchestration and finalization
    │   │   ├── job-store.ts / job-*.ts  # durable jobs, locks, and reservations
    │   │   ├── queue.ts / scheduler.ts  # request admission and scheduled work
    │   │   └── repository.ts / types.ts # published bundle access and contracts
    │   └── market-data/
    │       ├── api-home.ts / api-related.ts # focused page-level read APIs
    │       ├── queries.ts       # detail-query facade
    │       ├── price-queries.ts / stock-details-query.ts / news-queries.ts
    │       ├── cache.ts         # candles + Astra reads via unstable_cache
    │       ├── cache-market.ts  # market-wide movers and year-ago closes
    │       ├── cache-quotes.ts  # targeted quote snapshots for peer sets
    │       ├── cache-meta.ts    # ticker detail, related tickers, search
    │       ├── alpaca.ts        # bars, live tail, snapshots
    │       ├── quote-metrics.ts # shared quote-window calculations
    │       ├── finnhub.ts       # profile, peers, search
    │       ├── polygon.ts       # authenticated fetch + status check
    │       ├── news-loaders.ts  # write path: Polygon/Alpaca news ingest
    │       ├── news-store.ts / news-store-*.ts # article, verdict, and pruning persistence
    │       ├── analysis.ts      # validated direct-Groq analysis preparation
    │       ├── analysis-prompt.ts / analysis-helpers.ts # analysis contract and execution
    │       ├── range-bars.ts / range-bar-*.ts # bounded price series and providers
    │       ├── market-rankings.ts / market-ranking-*.ts # mover ranking and retrieval
    │       ├── security-master.ts / security-master-*.ts # canonical instrument identities
    │       ├── sec-edgar.ts / sec-edgar-*.ts # SEC facts, filings, and normalization
    │       ├── universe.ts      # local search over universe.json
    │       ├── limiter.ts       # per-provider sliding rate limiter
    │       ├── transforms*.ts   # normalization, sentiment math, activity series
    │       └── types.ts         # shared market-data types
    ├── context/
    │   └── ChartContext.tsx     # shared chart range/state across a page
    ├── data/
    │   ├── universe.json        # ~12,500 US tickers, built from Alpaca
    │   ├── mockStocks.ts        # default/featured stocks for demo mode
    │   └── fallbacks/           # mock generators, related-stock and ticker-list fallbacks
    ├── styles/                  # base, tokens, animations, login, error CSS layers
    └── types/
        └── next-auth.d.ts       # session/user type augmentation
```

## Where to start reading

- Read path: `src/app/details/[id]/page.tsx`, then `src/lib/market-data/queries.ts`.
- Write path: `src/lib/market-intelligence/worker.ts`, then
  `src/lib/market-data/news-loaders.ts` and `analysis.ts`.
- Chat: `src/app/actions.ts`, then `src/lib/stocksage/chat.ts`.

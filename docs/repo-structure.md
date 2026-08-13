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
│   ├── market-intelligence-runbook.md
│   └── repo-structure.md
├── tests/
│   ├── no-live-keys.ts          # shared setup, imported before config-freezing modules
│   ├── market-intelligence/     # worker, queue, job-store, showcase, and repository tests
│   ├── stocksage/                # conversation, policy, temporal, and simple-runtime tests
│   └── market-data/              # market-rankings, sec-edgar, and security-master tests
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
    │       ├── DetailsSkeletons.tsx # route-local loading skeletons (page + view)
    │       ├── RelatedStocksSection.tsx # eager independent streamed peers
    │       ├── actions.ts       # detail reads, refresh enqueue/status, charts
    │       └── loading.tsx      # skeleton while the page streams
    ├── components/
    │   ├── layout/              # Nav, HeaderGate, SearchBar, breadcrumb, theme toggle, user menu
    │   ├── charts/              # MainChart, StockGraph, PopularityGraph, PopularityChart, RangeSelector, grid/range helpers
    │   ├── chat/                # FloatingWidget, ChatMessage, and the StockSage chat surface
    │   ├── news/                # NewsCard, NewsModal, VerdictModal, TopNews, RecentInfluential, Bar
    │   ├── stocks/              # Overview, StockChips, TopGainer, mover presentation mapping
    │   ├── shared/              # FlipCard, SentimentLabel, ModalFrame
    │   ├── login/               # LoginForm, Guilloche background, BrandMarquee
    │   ├── error/               # ErrorScene
    │   ├── legal/               # LegalModal (disclaimer)
    │   └── ui/                  # shared button, card, chart, menu, and progress primitives
    ├── hooks/
    │   ├── useStaleData.ts      # stale-while-revalidate client hook
    │   └── useModalDismiss.ts   # shared modal mount/Escape/scroll-lock lifecycle
    ├── lib/
    │   ├── config.ts            # feature flags derived from which env keys exist
    │   ├── market-calendar.ts   # shared US/AU sessions, holidays, and interval types
    │   ├── resilience/
    │   │   ├── breaker.ts       # isolated provider and workload breakers
    │   │   ├── rate-limit.ts    # Upstash sliding-window limiter
    │   │   └── guard.ts         # per-action, per-identity rate guard
    │   ├── llm/
    │   │   ├── index.ts         # vendor-agnostic chat transport (llmChatJSON/llmChatText)
    │   │   ├── groq.ts          # groqChatJSON transport (reduced public surface)
    │   │   └── llm-json.ts      # fenced-JSON parsing for LLM output
    │   ├── auth-actions.ts      # sign-in / sign-out server actions
    │   ├── client/
    │   │   ├── prefetch.ts      # hover/route prefetch helpers
    │   │   └── stale-cache.ts   # sessionStorage cache primitives (no React dependency)
    │   ├── tickers.ts           # ticker resolution from free text
    │   ├── telemetry.ts         # structured StockSage and market-data events
    │   ├── utils.ts             # cn() and small shared helpers
    │   ├── stocksage/
    │   │   ├── chat.ts          # stable wrapper for the simple runtime
    │   │   ├── simple-runtime.ts # compatibility facade for the simple pipeline
    │   │   ├── simple/           # extraction, retrieval, composition, and orchestration
    │   │   ├── conversation/     # public facade (resolveConversationState) + entity/group/correction/reference state transitions
    │   │   ├── temporal/         # public temporal facade (index.ts) + calendar, parsing, interval, and type helpers
    │   │   ├── entity/           # entity catalog, hints, resolution, and state helpers
    │   │   ├── policy/           # public policy facade (index.ts) + crisis and social-pattern prefilters
    │   │   ├── evidence/astra.ts # published market-intelligence evidence reader
    │   │   ├── citations.ts     # source-ID validation and safe link expansion
    │   │   ├── tavily.ts        # bounded server-side Tavily fetch wrapper
    │   │   ├── text-normalization.ts # shared typo-tolerant string matching
    │   │   └── types.ts         # validated chat contracts
    │   ├── market-intelligence/
    │   │   ├── worker/
    │   │   │   ├── index.ts               # public facade (runTickerRefreshJob, finalize*)
    │   │   │   ├── refresh-worker.ts       # refresh orchestration
    │   │   │   ├── refresh-finalization.ts # terminal-failure finalization
    │   │   │   └── worker-types.ts         # worker/finalize dependency contracts
    │   │   ├── job-store/
    │   │   │   ├── index.ts               # public facade (reservations, locks, types)
    │   │   │   ├── job-store-types.ts      # job/reservation/lock record shapes
    │   │   │   ├── job-store-runtime.ts    # shared Redis/memory primitives
    │   │   │   ├── job-locks.ts            # per-ticker lock acquire/renew/release
    │   │   │   └── job-reservations.ts     # job reservation + state transitions
    │   │   ├── queue.ts / scheduler.ts  # request admission and scheduled work
    │   │   ├── fingerprints.ts / freshness.ts # content hashing and staleness rules
    │   │   ├── showcase.ts / telemetry.ts     # showcase selection and structured events
    │   │   └── repository.ts / types.ts # published bundle access and contracts
    │   └── market-data/
    │       ├── types.ts         # shared market-data types
    │       ├── provenance.ts    # shared source/provenance stamping
    │       ├── api/
    │       │   ├── home.ts      # focused home-page read API
    │       │   └── related.ts   # focused related-stocks read API
    │       ├── providers/
    │       │   ├── alpaca.ts    # bars, live tail, snapshots
    │       │   ├── finnhub.ts   # profile, peers, search
    │       │   ├── polygon.ts   # authenticated fetch + status check
    │       │   └── limiter.ts   # per-provider sliding rate limiter
    │       ├── cache/
    │       │   ├── index.ts         # candles + Astra reads via unstable_cache
    │       │   ├── cache-market.ts  # market-wide movers and year-ago closes
    │       │   ├── cache-quotes.ts  # targeted quote snapshots for peer sets
    │       │   └── cache-meta.ts    # ticker detail, related tickers, search
    │       ├── queries/
    │       │   ├── index.ts               # detail-query facade
    │       │   ├── price-queries.ts
    │       │   ├── news-queries.ts
    │       │   └── stock-details-query.ts
    │       ├── transforms/
    │       │   ├── index.ts               # normalization, mover formatting facade
    │       │   ├── transforms-activity.ts # activity series
    │       │   ├── transforms-insight.ts  # sentiment math, related-stock scoring
    │       │   └── transforms-news.ts     # news dedupe/window/summary
    │       ├── news/
    │       │   ├── loaders.ts   # write path: Polygon/Alpaca news ingest
    │       │   ├── store/
    │       │   │   ├── index.ts                  # article, verdict, pruning facade
    │       │   │   ├── news-store-client.ts
    │       │   │   ├── news-store-articles.ts
    │       │   │   ├── news-store-analysis.ts
    │       │   │   └── news-store-pruning.ts
    │       │   └── analysis/
    │       │       ├── index.ts             # validated direct-Groq analysis preparation
    │       │       ├── analysis-helpers.ts  # analysis execution + MAX_ARTICLES_PER_PASS
    │       │       └── analysis-prompt.ts   # analysis contract prompt
    │       ├── market-rankings/
    │       │   ├── index.ts                          # mover ranking and retrieval facade
    │       │   ├── market-ranking-core.ts
    │       │   ├── market-ranking-types.ts
    │       │   ├── market-ranking-retrieval.ts
    │       │   ├── market-ranking-alpaca.ts
    │       │   ├── market-ranking-polygon-live.ts
    │       │   └── market-ranking-polygon-history.ts
    │       ├── range-bars/
    │       │   ├── index.ts               # bounded price series facade
    │       │   ├── range-bar-types.ts / range-bar-values.ts
    │       │   ├── range-bar-calendar.ts / range-bar-coverage.ts
    │       │   ├── range-bar-cache.ts / range-bar-quote.ts / range-bar-routing.ts
    │       │   ├── range-bar-series.ts
    │       │   ├── quote-metrics.ts       # shared quote-window calculations
    │       │   └── providers/             # range-bar-provider-alpaca/polygon/stooq/yahoo/factory
    │       ├── security-master/
    │       │   ├── index.ts                              # canonical instrument identities facade
    │       │   ├── universe.ts                           # local search over universe.json
    │       │   ├── corporate-action-normalization.ts
    │       │   └── security-master-*.ts                  # normalization, types, per-provider adapters
    │       └── sec-edgar/
    │           ├── index.ts               # SEC facts, filings, and normalization facade
    │           └── sec-edgar-*.ts         # client, http, facts, filings, normalization, types, urls
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

- Read path: `src/app/details/[id]/page.tsx`, then `src/lib/market-data/queries/index.ts`.
- Write path: `src/lib/market-intelligence/worker/index.ts`, then
  `src/lib/market-data/news/loaders.ts` and `news/analysis/index.ts`.
- Chat: `src/app/actions.ts`, then `src/lib/stocksage/chat.ts`.

# Repo structure

The source tree, annotated. Config and generated files are omitted.

```
.
├── .github/workflows/
│   ├── ci.yml                   # typecheck, lint, tests, and production build
│   └── news-cron.yml            # legacy/manual cron diagnostic
├── langflow/
│   ├── README.md                # manual evaluation instructions
│   └── stocksage-analysis.json  # optional analysis comparison flow
├── scripts/
│   ├── build-universe.mjs       # rebuilds universe.json from Alpaca's asset list
│   ├── run-showcase-cron.ts     # invokes the showcase scheduler manually
│   ├── load-news.ts             # loads news for a single ticker
│   ├── analyze-ticker.ts        # analyzes a single ticker
│   ├── setup-qstash.ts          # reconciles showcase + maintenance schedules
│   ├── stocksage-smoke.ts       # runs the StockSage smoke scenarios
│   ├── stocksage-eval.ts        # runs the broader StockSage evaluation set
│   └── sync-system-prompt.mjs   # syncs analysis instructions to the retained flow
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
    │   ├── TextAnimations/      # VariableProximity text effect
    │   └── ui/                  # shadcn-style primitives (button, card, select, form, ...)
    ├── lib/
    │   ├── config.ts            # feature flags derived from which env keys exist
    │   ├── breaker.ts           # isolated provider and workload breakers
    │   ├── rate-limit.ts        # Upstash sliding-window limiter
    │   ├── guard.ts             # per-action, per-identity rate guard
    │   ├── langflow.ts          # runLangflowFlow transport
    │   ├── groq.ts              # groqChatJSON / groqChatText transport
    │   ├── llm-json.ts          # fenced-JSON parsing for LLM output
    │   ├── auth-actions.ts      # sign-in / sign-out server actions
    │   ├── movers.ts            # market movers helpers
    │   ├── prefetch.ts          # hover/route prefetch helpers
    │   ├── tickers.ts           # ticker resolution from free text
    │   ├── useStaleData.ts      # stale-while-revalidate client hook
    │   ├── utils.ts             # cn() and small shared helpers
    │   ├── stocksage/
    │   │   ├── chat.ts          # stable wrapper for the unified engine
    │   │   ├── engine.ts / answer.ts # five-stage lifecycle and sole answer executor
    │   │   ├── router.ts / context.ts # authoritative frozen turn resolution
    │   │   ├── publication.ts   # shared regular/deep publication contract
    │   │   ├── deterministic-answer.ts / degraded-answer.ts # focused safe answer helpers
    │   │   ├── conversation-entity-state.ts / entity-state-helpers.ts # entity state transitions
    │   │   ├── regular-*.ts     # focused prompt, guards, history, and fallback helpers
    │   │   ├── deep/            # durable queue, worker, snapshot, store, validation
    │   │   ├── evidence/        # planner, cache-first retrieval, filters, provider helpers
    │   │   ├── policy.ts        # finance-domain and misuse policy
    │   │   ├── crisis.ts        # zero-cost crisis-language prefilter
    │   │   ├── safety-classifier.ts # custom-policy safeguard rail behind the prefilter
    │   │   ├── state.ts         # untrusted state canonicalization
    │   │   ├── conversation-attributes.ts # criteria, horizon, and jurisdiction detection
    │   │   ├── citations.ts     # source-ID validation and safe link expansion
    │   │   ├── entity-catalog.ts # aliases, groups, and non-US listings
    │   │   ├── entities.ts      # US quote-safe and web-only entity resolution
    │   │   ├── intent.ts        # deterministic route decisions
    │   │   ├── regular-prompt.ts    # evidence-bound intent-aware prompt
    │   │   ├── synthesis.ts     # isolated Groq model failover and admission
    │   │   ├── tavily.ts        # bounded server-side Tavily fetch wrapper
    │   │   ├── telemetry.ts     # structured StockSage request telemetry
    │   │   ├── types.ts         # validated chat contracts
    │   │   ├── prompt.ts        # loads the Deep Research system prompt
    │   │   ├── analysis-prompt.ts   # the deep-analysis instructions
    │   │   └── system-prompt.json   # Deep Research system prompt
    │   ├── market-intelligence/ # bundle contracts, queue, worker, scheduler
    │   └── market-data/
    │       ├── index.ts         # public re-exports
    │       ├── api.ts           # high-level read API (movers, quotes, home bundles)
    │       ├── queries.ts       # detail-page assembly and news summary
    │       ├── cache.ts         # candles + Astra reads via unstable_cache
    │       ├── cache-market.ts  # market-wide movers and year-ago closes
    │       ├── cache-quotes.ts  # targeted quote snapshots for peer sets
    │       ├── cache-meta.ts    # ticker detail, related tickers, search
    │       ├── alpaca.ts        # bars, live tail, snapshots
    │       ├── quote-metrics.ts # shared quote-window calculations
    │       ├── finnhub.ts       # profile, peers, search
    │       ├── polygon.ts       # authenticated fetch + status check
    │       ├── news-loaders.ts  # write path: Polygon/Alpaca news ingest
    │       ├── news-store.ts    # Astra reads/writes for articles and verdicts
    │       ├── analysis.ts      # validated direct-Groq analysis preparation
    │       ├── analysis-helpers.ts  # prompt build, Zod schema, runAnalysisLLM
    │       ├── universe.ts      # local search over universe.json
    │       ├── langflow-analysis-provider.ts # manual/evaluation-only Langflow adapter
    │       ├── limiter.ts       # per-provider sliding rate limiter
    │       ├── queries.ts / transforms*.ts  # normalization, sentiment math, activity series
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

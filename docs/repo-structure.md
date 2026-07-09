# Repo structure

The source tree, annotated. Config and generated files are omitted.

```
.
├── .github/workflows/
│   ├── news-cron.yml            # runs /api/cron/news every 5 minutes
│   └── keep-warm.yml            # pings the Langflow host every 15 minutes
├── langflow/
│   ├── README.md                # the flows, and how the Groq fallback mirrors them
│   ├── stocksage-chat.json      # RAG chat flow (Astra + Tavily + Groq 70B)
│   └── stocksage-analysis.json  # stateless article-to-labels flow (Groq 8B)
├── scripts/
│   ├── build-universe.mjs       # rebuilds universe.json from Alpaca's asset list
│   ├── run-cron.ts              # runs one ingestion pass locally
│   ├── load-news.ts             # loads news for a single ticker
│   ├── analyze-ticker.ts        # analyzes a single ticker
│   └── sync-system-prompt.mjs   # bakes the app prompts into the Langflow JSONs
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
    │   ├── actions.ts           # chat server actions (warmStockSage, getSummary)
    │   ├── globals.css          # imports the style layers in src/styles
    │   ├── error.tsx            # error boundary page
    │   ├── not-found.tsx        # 404 page
    │   ├── login/page.tsx       # sign-in screen
    │   ├── api/
    │   │   ├── auth/[...nextauth]/route.ts  # Auth.js route handlers
    │   │   └── cron/news/route.ts           # the ingestion cron endpoint
    │   └── details/[id]/
    │       ├── page.tsx         # detail route, assembles StockData server-side
    │       ├── DetailsView.tsx  # detail client UI (flip card, news panel, peers)
    │       ├── actions.ts       # detail server actions (quotes, charts, related)
    │       ├── priority.ts      # cold-ticker priority analysis trigger
    │       └── loading.tsx      # skeleton while the page streams
    ├── components/
    │   ├── layout/              # Nav, HeaderGate, SearchBar, breadcrumb, theme toggle, user menu
    │   ├── charts/              # MainChart, StockGraph, PopularityGraph, grid/range helpers
    │   ├── chat/                # FloatingWidget, the StockSage chat surface
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
    │   ├── breaker.ts           # circuit breaker (Polygon, Groq, Langflow)
    │   ├── rate-limit.ts        # Upstash sliding-window limiter
    │   ├── guard.ts             # per-action, per-identity rate guard
    │   ├── langflow.ts          # runLangflowFlow transport
    │   ├── groq.ts              # groqChatJSON / groqChatText, the direct fallback
    │   ├── llm-json.ts          # fenced-JSON parsing for LLM output
    │   ├── auth-actions.ts      # sign-in / sign-out server actions
    │   ├── movers.ts            # market movers helpers
    │   ├── prefetch.ts          # hover/route prefetch helpers
    │   ├── tickers.ts           # ticker resolution from free text
    │   ├── useStaleData.ts      # stale-while-revalidate client hook
    │   ├── utils.ts             # cn() and small shared helpers
    │   ├── stocksage/
    │   │   ├── chat.ts          # chat orchestration (grounding, Langflow, fallback)
    │   │   ├── prompt.ts        # loads the chat system prompt
    │   │   ├── analysis-prompt.ts   # the deep-analysis instructions
    │   │   └── system-prompt.json   # canonical chat system prompt
    │   └── market-data/
    │       ├── index.ts         # public re-exports
    │       ├── api.ts           # high-level read API (movers, quotes, home bundles)
    │       ├── queries.ts       # detail-page assembly and news summary
    │       ├── cache.ts         # candles + Astra reads via unstable_cache
    │       ├── cache-market.ts  # market-wide movers and year-ago closes
    │       ├── cache-quotes.ts  # targeted quote snapshots for peer sets
    │       ├── cache-meta.ts    # ticker detail, related tickers, search
    │       ├── alpaca.ts        # bars, live tail, snapshots
    │       ├── finnhub.ts       # profile, peers, search
    │       ├── polygon.ts       # authenticated fetch + status check
    │       ├── news-loaders.ts  # write path: Polygon/Alpaca news ingest
    │       ├── news-store.ts    # Astra reads/writes for articles and verdicts
    │       ├── analysis.ts      # analysis orchestration (Langflow-first)
    │       ├── analysis-helpers.ts  # prompt build, Zod schema, runAnalysisLLM
    │       ├── universe.ts      # local search over universe.json
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
- Write path: `src/app/api/cron/news/route.ts`, then `src/lib/market-data/news-loaders.ts` and `analysis.ts`.
- Chat: `src/app/actions.ts`, then `src/lib/stocksage/chat.ts`.

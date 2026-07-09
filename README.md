# TradeIntel

TradeIntel is a stock research dashboard built around news sentiment. Search any ticker for its price chart, a news sentiment read, and its closest peers. StockSage, the built-in assistant, answers follow-up questions grounded in live quotes and, when it can reach its news index, the same stored analysis.

TradeIntel home screen with the price chart, sentiment gauge, and top market movers

> **Live:** [tradeintel.example.com](https://your-deployment-url.example) (sign in with Google)
>
> **Note:** a research project, not financial advice.

A background pipeline works through thousands of tickers routinely. For each one it pulls recent news, scores an interim sentiment, then runs an LLM pass for a per-article read and an overall verdict, writing all of it to a store. Pages stay fast by reading that finished result plus a live price feed, never waiting on the pipeline itself. [How it works →](docs/architecture.md)

## Getting started

```bash
git clone https://github.com/your-username/tradeintel.git
cd tradeintel
npm install
npm run dev
```

No API keys required. An empty `.env.local` runs the whole app on mock data; copy `.env.example` and fill in the keys you want to switch features over to live data. Needs Node 20+.

## Documentation


| Document                                 | What's inside                                      |
| ---------------------------------------- | -------------------------------------------------- |
| [Screenshots](docs/screenshots.md)       | The app, screen by screen                          |
| [Stack](docs/stack.md)                   | What it's built with, and why                      |
| [Architecture](docs/architecture.md)     | Request flow, providers, caching, failure handling |
| [Data pipeline](docs/data-pipeline.md)   | How news gets fetched, analyzed, and stored        |
| [API reference](docs/api.md)             | The HTTP routes and server actions                 |
| [Configuration](docs/configuration.md)   | Environment variables and run modes                |
| [Deployment](docs/deployment.md)         | Hosting, the cron jobs, and the Langflow host      |
| [Repo structure](docs/repo-structure.md) | The source tree, annotated                         |
| [Langflow flows](langflow/README.md)     | The chat and analysis flows                        |


---

> **On the origin.** This started as a [university hackathon project](https://devpost.com/software/tradeintel) built with a team in March 2025, where we shipped a rough homepage and detail page over a weekend. The version here was rebuilt solo through mid-2026: the store-first pipeline, the provider split, the Langflow flows, auth, the chat assistant, and the current UI. The commit history has the full trail.


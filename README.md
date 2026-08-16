# TradeIntel

TradeIntel is a stock research dashboard built around news sentiment. Search any ticker for its price chart, a news sentiment read, and its closest peers. StockSage, the built-in assistant, answers follow-up questions grounded in live quotes and, when it can reach its news index, the same stored analysis.

> **Live:** [trade-intel-app.vercel.app](https://trade-intel-app.vercel.app) (sign in with Google)
>
> **Note:** a research project, not financial advice.

A 30-minute showcase schedule and authenticated on-demand requests publish durable per-ticker jobs through QStash. Each worker fetches recent news, reconfirms or regenerates the analysis, and atomically publishes a current system conclusion to Astra DB. Pages stay fast by reading that finished bundle plus cached market data, never waiting on providers or an LLM. [How it works →](docs/architecture.md)

## Getting started

```bash
git clone https://github.com/HarshitBadam/trade-intel.git
cd trade-intel
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
| [Deployment](docs/deployment.md)         | Hosting, cron jobs, queues, and provider setup     |
| [Market intelligence runbook](docs/market-intelligence-runbook.md) | Showcase cron, workers, and ops recovery |
| [Repo structure](docs/repo-structure.md) | The source tree, annotated                         |


---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

---

> **On the origin.** This started as a [university hackathon project](https://devpost.com/software/tradeintel) built with a team in March 2025, where we shipped a rough homepage and detail page over a weekend. The version here was rebuilt solo through mid-2026: the store-first pipeline, provider integrations, auth, the chat assistant, and the current UI. The commit history has the full trail.

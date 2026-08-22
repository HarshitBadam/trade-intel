# Trade Intel

Trade Intel is a stock research dashboard that brings price history, trading volume, market news, sentiment, and popularity into a single view. Search any ticker to explore interactive price and popularity charts, trace the articles driving sentiment, compare related companies, and inspect the latest analytical conclusion. StockSage is the built-in research assistant, combining live market data, stored news evidence, web research, ranking tools, and historical range analysis to answer stock research questions with cited evidence.

> **Live:** [trade-intel-app.vercel.app](https://trade-intel-app.vercel.app) (sign in with Google)
>
> **Note:** A research project, not financial advice.

Trade Intel uses a store-first market-intelligence architecture: slow or failure-prone enrichment runs as durable background work, while product requests read only versioned, already-published results. Scheduled and on-demand refreshes converge on the same atomic publication boundary, keeping every conclusion consistent with its supporting articles and insulating page performance from provider and model latency. [How it works →](docs/architecture.md)

<details open>
<summary><strong>Product walkthrough</strong></summary>

### Home

Featured stock chart, top movers, and the latest headline on one screen.

![Home dashboard](docs/screenshots/home.png)

### Search

Search roughly 12,500 tickers locally, with results appearing as you type and no network round trip.

![Ticker search](docs/screenshots/search.png)

### Stock detail

Explore price history, trading volume, market context, and related companies for any ticker.

![Stock detail page](docs/screenshots/details.png)

### Sentiment and news

Trace the articles driving the current read, with per-story sentiment and analysis freshness.

![Sentiment and influential news](docs/screenshots/sentiment.png)

### Analytical verdict

Review the latest conclusion, confidence, summary, and key market drivers.

![Ticker analytical verdict](docs/screenshots/verdict.png)

### Popularity view

Flip the price card into a 90-day sentiment and article-activity view.

![Sentiment and popularity chart](docs/screenshots/popularity.png)

### StockSage

Ask stock research questions and receive evidence-grounded answers with supporting citations.

![StockSage chat](docs/screenshots/chat.png)

### Sign in

Sign in with Google over the animated guilloche background.

![Login screen](docs/screenshots/login.png)

</details>

## Getting started

```bash
git clone https://github.com/HarshitBadam/trade-intel.git
cd trade-intel
npm install
npm run dev
```

No API keys required. An empty `.env.local` runs the whole app on mock data; copy `.env.example` and fill in the keys you want to switch features over to live data. Needs Node 20+.

## Notable features

**StockSage:** StockSage is an evidence-grounded research assistant with tools for live market data, stored news, web research, US stock rankings, and historical range analysis. It retrieves the required evidence in parallel, applies financial-safety guardrails, and composes cited answers rather than relying on model memory.

**Sentiment and popularity:** Trade Intel combines article-level sentiment with a ticker verdict covering overall direction, confidence, summary, and key drivers. Its 90-day popularity view blends sentiment balance with article activity, making changes in market attention visible alongside price and volume.

**Durable market intelligence:** Scheduled and on-demand refreshes enter the same durable worker pipeline. Content fingerprints avoid unnecessary analysis regeneration, while versioned, compare-and-set publication ensures every displayed conclusion matches the exact set of supporting articles.

**Fast stock discovery:** Search runs locally across roughly 12,500 tickers without a network round trip. Detail pages combine cached charts and fundamentals with lazily loaded peers and previously published intelligence, keeping the research flow responsive.

## Documentation

| Document                                                           | What's inside                                      |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| [Stack](docs/stack.md)                                             | What it's built with, and why                      |
| [Architecture](docs/architecture.md)                               | Request flow, providers, caching, failure handling |
| [Data pipeline](docs/data-pipeline.md)                             | How news gets fetched, analyzed, and stored        |
| [API reference](docs/api.md)                                       | The HTTP routes and server actions                 |
| [Configuration](docs/configuration.md)                             | Environment variables and run modes                |
| [Deployment](docs/deployment.md)                                   | Hosting, cron jobs, queues, and provider setup     |
| [Market intelligence runbook](docs/market-intelligence-runbook.md) | Showcase cron, workers, and ops recovery           |
| [Repo structure](docs/repo-structure.md)                           | The source tree, annotated                         |
| [Langflow evolution](langflow/README.md)                           | Historical flows and production migration context |

---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

---

> **On the origin.** This started as a [university hackathon project](https://devpost.com/software/tradeintel) built with a team in March 2025, where we shipped a rough homepage and detail page over a weekend. The version here was rebuilt solo through mid-2026: the store-first pipeline, provider integrations, auth, the chat assistant, and the current UI. The commit history has the full trail.


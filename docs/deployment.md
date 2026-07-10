# Deployment

A standard Next.js deploy plus two QStash schedules.

## Hosting

The app runs on Vercel. Connect the repo and it builds on push, or build it yourself with `npm run build` and `npm start`. Set the environment variables from [configuration.md](configuration.md) in the project settings; live mode wants the market, store, and AI groups, plus auth (see the safety rule in that doc). Serverless functions are capped at 60s (`maxDuration` in `src/app/layout.tsx`), and the cron endpoint runs close to that.

## Background jobs

QStash owns the recurring schedules:

| Schedule | Cadence | What it does |
|----------|---------|--------------|
| `tradeintel-news-cron` | Every 5 minutes | Calls `/api/cron/news` with a bearer token to ingest news and run analysis |
| `tradeintel-keep-warm` | Every 15 minutes | Pings the Langflow host's `/health` so it does not fall asleep |

Fill the QStash, cron, and Langflow values in `.env.local`, then create or
reconcile both schedules:

```bash
npm run ops:qstash
```

The setup is idempotent and keeps the news lane single-flight. The GitHub
Actions workflows remain as manually dispatched diagnostics, with strict HTTP
and response validation. `vercel.json` also registers a once-a-day cron on the
news endpoint as a backstop.

## The Langflow host

StockSage's flows run on a separate Langflow instance (a Hugging Face Space in this setup). It can sleep or drop into an error state, which is why every call has a direct-Groq fallback and why the keep-warm job exists. Import and secret-setup steps for the flows are in [langflow/README.md](../langflow/README.md).

# Deployment

A standard Next.js deploy plus durable QStash market-intelligence work.

## Hosting

The app runs on Vercel. Connect the repo and it builds on push, or build it
yourself with `npm run build` and `npm start`. Set the environment variables
from [configuration.md](configuration.md) in the project settings. Live mode
requires auth; the details page and its enqueue actions are not anonymous
provider-spend endpoints.

## Background jobs

QStash owns two recurring schedules:

| Schedule | Cadence | What it does |
|----------|---------|--------------|
| `tradeintel-showcase-cron` | Hourly | Calls `/api/cron/showcase`, which publishes ten paced ticker refresh jobs |
| `tradeintel-maintenance-cron` | Daily | Calls `/api/cron/maintenance` to prune articles older than 90 days |

Fill the QStash, Redis, cron, and app-origin values in `.env.local`, then create or
reconcile both schedules:

```bash
npm run ops:qstash
```

The setup deletes the retired universe-news and Langflow keep-warm schedules
before reconciling the showcase and maintenance schedules. Showcase jobs are
staggered by one minute to avoid a provider/LLM burst. `vercel.json` also
registers the maintenance endpoint as a daily backstop.

User visits publish the same signed worker job used by the showcase scheduler.
Redis stores one active work ID per ticker, job status, and an owner-safe lease.
The worker endpoint bypasses session middleware only so QStash can reach it; it
still fails closed unless the QStash signature verifies.

QStash performs three total delivery attempts. Its signed failure callback
marks the job terminal, preserves the last usable bundle, and applies a short
retry cooldown. There is no synchronous provider or model fallback in a page
request. Deployment checks, incident handling, and rollback steps are in the
[market-intelligence runbook](market-intelligence-runbook.md).

## The Langflow host

Langflow remains an optional manual/evaluation adapter. Details-page market
analysis uses direct Groq and does not call Langflow or maintain a keep-warm
schedule. Import and secret-setup steps for evaluation are in
[langflow/README.md](../langflow/README.md).

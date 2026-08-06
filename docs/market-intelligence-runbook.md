# Market-intelligence runbook

## Before enabling schedules

1. Rotate any previously exposed provider or database credentials.
2. Deploy the worker routes with QStash signing keys, `APP_URL`, and Upstash
   Redis configured.
3. Confirm an unsigned worker request returns 401.
4. Run one signed manual refresh for a non-showcase ticker and verify
   `queued -> running -> done`, a new analysis generation, exact published
   article IDs, and ticker-scoped cache invalidation.
5. Run `npm run ops:showcase` and verify ten selected jobs with one-minute
   delivery offsets.

Do not run `npm run ops:qstash` until these checks pass: it changes external
QStash schedules.

## Healthy signals

- Showcase reports select ten canonical tickers hourly.
- Duplicate requests report `refresh_joined`, not a second queued job.
- Most unchanged refreshes finish with `outcome: reused` and make no Groq call.
- Locks release on every terminal path; CAS rejection appears only for an
  intentionally obsolete worker.
- Showcase `news_checked_at` values remain approximately hourly.
- Details requests make no Polygon, Alpaca-news, or Groq calls.

Structured logs use the `[market-intelligence]` prefix and never contain
credentials or article bodies.

## User-visible failure policy

- Keep a usable bundle visible below 48 hours and describe it as the previous
  checked snapshot.
- Stop active polling after roughly two minutes; work may continue in the
  background.
- At 48 hours, remove the old bundle from current-result presentation.
- After exhausted model failures, fresh staged headlines may publish without a
  verdict as `analysis_unavailable`.
- Never publish sample news in live mode.

## Incident response

### QStash or Redis unavailable

On-demand enqueue fails closed and performs no provider work in the request.
Keep existing content visible. Confirm Redis/QStash status, signing keys, and
`APP_URL`; then retry after the recorded cooldown.

### Provider or Groq outage

Inspect breaker and worker error codes. Preserve the published generation and
let bounded QStash retries finish. Resume with a new work ID after cooldown.

### Stuck active job

Check the job timestamp and ticker lease. Active reservations expire after 15
minutes and status records after 24 hours. Do not delete a live owner lock. If
the worker is conclusively gone, wait for lease/active expiry and enqueue a new
job.

### Unexpected mixed content

Compare the analysis document's generation, `published_article_ids`, and
`published_article_labels` with the returned bundle. A page must never query
unreferenced staged articles. Pause the showcase schedule before correcting
the reader or publisher.

## Rollback

1. Pause `tradeintel-showcase-cron` in QStash.
2. Leave maintenance enabled unless pruning is implicated.
3. Redeploy the previous known-good application release.
4. Do not delete Astra article or analysis rows; they are backward-compatible
   and preserve last-known-good data.
5. Keep worker logs and failed QStash messages for diagnosis, rotating any
   credential that may have appeared outside approved secret storage.

Observe the new worker and showcase lane for at least 48 healthy hours before
removing rollback infrastructure or declaring the operational rollout
complete.

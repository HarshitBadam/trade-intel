# TradeIntel — Stock Sentiment Dashboard

TradeIntel tracks stock performance and AI-analysed news sentiment, with **StockSage**,
an AI chat assistant powered by a [Langflow](https://www.langflow.org/) flow (originally
hosted on DataStax Astra, now IBM).

Built with Next.js 15 (App Router), React 19, Tailwind CSS 4, shadcn/ui, Recharts,
Framer Motion, and Auth.js (NextAuth v5).

---

## Quick start (demo mode — no keys, no cost)

```bash
npm install
npm run dev   # http://localhost:3000
```

With no environment variables set, the app runs in **open demo mode**: every external
data source falls back to deterministic mock data, so charts, search, news sentiment and
the StockSage chat all work — and **no billable API is ever called**.

---

## Security & cost model (read before deploying)

This app is designed to be cost-safe and abuse-resistant as a public showcase. Defense in
depth, in order of the owner's priorities (don't lose money → don't go down → access control):

1. **No key, no spend — and in production, no enforced auth, no spend either.** Each
   integration (Polygon, Astra, Langflow/OpenAI) is only called when its credentials are
   present *and* live calls are allowed (`src/lib/config.ts`). In production, live calls are
   allowed **only when authentication is actually enforced**, so a half-finished deploy
   (data keys added, OAuth not wired yet) silently serves mock data instead of spending —
   and logs a loud `[TradeIntel] SECURITY` warning. Missing key ⇒ mock data everywhere.
2. **Every billable server action is guarded** (`src/lib/guard.ts`): it must pass an
   auth check (in production) and a per-identity rate limit *before* any external call.
   This holds even if the UI is bypassed and the action is invoked directly.
3. **Rate limiting** (`src/lib/rate-limit.ts`): Upstash Redis across all serverless
   instances when configured, with an in-memory fallback otherwise. Chat = 10/min,
   data = 30/min per user (or per IP in demo mode).
4. **Input caps:** chat messages are truncated to 1000 chars and tickers sanitised to
   `[A-Z.]{1,6}` before reaching any API/LLM (limits token spend and injection surface).
5. **Caching** (`unstable_cache`, 5–10 min): repeated requests for the same ticker hit a
   cache, not the upstream API — cutting both API spend and Vercel function time.
6. **Authentication** (Auth.js, Google/Apple, JWT sessions): when configured, the
   middleware redirects all unauthenticated traffic to `/login`.
7. **Server-only secrets:** no `NEXT_PUBLIC_` secrets; the Polygon key is sent via an
   `Authorization` header, never in a URL. Security headers + CSP in `next.config.ts`
   (`connect-src` locked to `'self'` in production); `X-Powered-By` removed; the app is
   `noindex` to keep crawlers off.

**Fail-closed by default:** in production, the app **cannot spend money until OAuth is
enforced**. So the worst case of a misconfigured/half-finished deploy is "open but
mock-only" (stays up, costs nothing) — never "open and billing". Auth enforcement turns on
automatically once `AUTH_SECRET` + a provider (Google/Apple) are set; do that (below)
before sharing the URL, and live data will light up at the same time.

---

## Project structure

- `src/app/page.tsx` — dashboard (trending, gainers/losers, news)
- `src/app/details/[id]/` — per-ticker detail (charts, sentiment, news)
- `src/app/api/cron/news/` — background news+sentiment ingestion endpoint
- `src/components/chat/FloatingWidget.tsx` — StockSage chat
- `src/auth.ts` / `src/auth.config.ts` / `src/middleware.ts` — Auth.js + route gating
- `src/lib/config.ts` / `guard.ts` / `rate-limit.ts` — config, auth+rate-limit guard
- `src/lib/market-data/` — providers (Alpaca/Finnhub/Polygon), cache, transforms, news store
- `src/data/fallbacks/` — deterministic demo-mode data generators
- `langflow/` — the two Langflow flows (RAG chat + deep analysis) and their README

---

## Deployment guide

See `.env.example` for the full list of variables. Below is the recommended order.

### 1 · Push to GitHub (`trade-intel`)

This repo currently carries the original shared hackathon git history. For a clean public
showcase (and to guarantee no old secret is buried in history), start a fresh history.

> **CRITICAL — rotate a leaked credential first.** An earlier commit (`53724c0`,
> from the original shared hackathon repo) hardcoded a live **Astra DB token**
> (`AstraCS:…`) in `src/app/actions.ts`. It was removed from the current code, but
> it still exists in git history and is exploitable until revoked.
> **Before doing anything else:** go to the Astra dashboard and **delete/rotate that
> token** (Astra → your DB → *Settings → Tokens*). Then start a fresh git history
> (below) so the old token never reaches the public repo.

```bash
# 1) from the repo root — wipe the shared history and start clean
rm -rf .git
git init
git add -A
git commit -m "Initial public release: TradeIntel"

# 2) (optional) verify no secret remains anywhere before pushing
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source=/repo -v
# or:  trufflehog filesystem .

# 3) create the GitHub repo and push
gh repo create trade-intel --public --source=. --remote=origin --push
# (or create it in the UI, then: git remote add origin <url> && git push -u origin main)
```

Because the history is brand-new, the leaked token (and the old `.idea/` files) are
gone from what you publish. Rotating the token in step 0 is still required — anyone who
already cloned the old repo has it.

### 2 · Deploy to Vercel

- Import the GitHub repo at [vercel.com/new](https://vercel.com/new).
- Framework preset: **Next.js** (auto-detected). Build: `next build`.
- Add the environment variables (below) for **Production** and **Preview**.
- **Set a spend cap:** Vercel → Project → Settings → **Spend Management** → set a monthly
  limit + auto-pause. This is your hard backstop against runaway usage.

### 3 · Authentication (Auth.js)

```bash
# Generate a session secret:
openssl rand -base64 32        # → AUTH_SECRET
```

- **Google** — [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
  OAuth client (Web). Authorized redirect URI:
  `https://<your-domain>/api/auth/callback/google`. Set `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.
- **Apple** — requires the **Apple Developer Program ($99/yr)**. Create a Services ID +
  a Sign in with Apple key (`.p8`). `AUTH_APPLE_SECRET` is a JWT you generate from the key
  (expires ≤6 months — must be rotated). See "Apple Sign In" below. Set `AUTH_APPLE_ID` /
  `AUTH_APPLE_SECRET`.

### 4 · Rate limiting (Upstash Redis) — do this before going public

Create a free serverless Redis at [upstash.com](https://upstash.com) (or via the Vercel
Marketplace) and set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. Without it,
rate limiting is per-instance only (weaker on serverless).

### 5 · Data + AI providers

- **Polygon.io** (`POLYGON_API_KEY`) — free key at
  [polygon.io](https://polygon.io/dashboard/signup). Free tier ≈ 5 req/min.
- **Astra DB** (`ASTRA_DB_APPLICATION_TOKEN`, `ASTRA_DB_API_ENDPOINT`) — free vector DB at
  [astra.datastax.com](https://astra.datastax.com). Powers news/sentiment + companies.
- **Langflow** (`LANGFLOW_BASE_URL`, `LANGFLOW_FLOW_ID`, `LANGFLOW_API_KEY`) — see below.

### 6 · Provider-side spend caps (belt and suspenders)

- **OpenAI** (used inside the Langflow flow): set a monthly **usage limit** in the OpenAI
  billing dashboard. This is the single biggest runaway-cost risk — cap it.
- **Polygon/Astra**: stay on free tiers, or set alerts if you upgrade.

---

### Apple Sign In — generating `AUTH_APPLE_SECRET`

The Apple client secret is a short-lived JWT signed with your `.p8` key. Generate it (and
re-generate every ≤6 months) — for example with the `jsonwebtoken` package:

```js
// node generate-apple-secret.mjs  (do NOT commit your .p8 or the output)
import jwt from "jsonwebtoken";
import fs from "node:fs";

const secret = jwt.sign({}, fs.readFileSync("./AuthKey_XXXX.p8"), {
  algorithm: "ES256",
  expiresIn: "180d",
  audience: "https://appleid.apple.com",
  issuer: "<YOUR_TEAM_ID>",
  subject: "<YOUR_SERVICES_ID>",      // = AUTH_APPLE_ID
  keyid: "<YOUR_KEY_ID>",
});
console.log(secret);                  // → AUTH_APPLE_SECRET
```

### Hosting the Langflow flows

The AI runs on two Langflow flows in `langflow/` (full details in `langflow/README.md`):
`stocksage-chat.json` (RAG chat grounded in the news store, Groq llama-3.3-70b)
and `stocksage-analysis.json` (stateless deep-analysis: stored articles in →
sentiment labels + verdict out, Groq llama-3.1-8b). News loading itself no
longer runs through Langflow — a background cron (`/api/cron/news`) pulls
Polygon news into Astra, and every Langflow call has a direct-Groq fallback.

1. Run Langflow (`pip install langflow && langflow run`) or use a hosted instance.
2. Add `GROQ_API_KEY` and `GOOGLE_API_KEY` global variables, then import both
   flows and set the Astra token (+ Tavily key for chat) inside the nodes.
3. Set `LANGFLOW_BASE_URL` (e.g. `http://localhost:7860`), then `LANGFLOW_FLOW_ID`
   (chat flow) and `LANGFLOW_ANALYZE_FLOW_ID` (analysis flow) plus `LANGFLOW_API_KEY`.

### Astra news document shape

The news pipeline expects a `prototype_db_v2` collection of documents like:

```json
{
  "page_content": "...",
  "metadata": {
    "ticker": "AAPL", "title": "...", "source": "...",
    "publication_date": "2025-01-01", "importance": "high",
    "sentiment": "Positive", "key_observations": "...", "url": "...", "event": "..."
  }
}
```

Rows are written by the background cron (`/api/cron/news`): Polygon articles
land with interim `insights` sentiment, then the deep-analysis pass relabels
the same rows and writes a per-ticker verdict doc to `stock_analysis`.

---

## Remaining product work (optional)

1. Finish the stub pages: `/stocks` (watchlist) and `/forecasts`.
2. The dashboard top cards (gainers/losers/news) are still hardcoded — derive them from
   Polygon snapshot endpoints once a key is set.
3. Tighten the CSP to a nonce-based policy (drop `unsafe-inline`/`unsafe-eval`).
4. Replace `<img>` tags with `next/image` (minor LCP/lint warnings).

## Notes

- `npm audit` reports a few moderate findings against the PostCSS copy bundled *inside*
  Next.js itself; the only offered "fix" is downgrading Next, so they're upstream noise.

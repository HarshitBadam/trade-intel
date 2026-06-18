import { NextResponse } from "next/server";
import { hasLangflowIngest } from "@/lib/config";
import { ingestTickerNews } from "@/lib/news-ingest";
import { warmMarketCaches, warmTicker } from "@/lib/market-data";
import { CRON_WARMUP_TICKERS } from "@/data/fallbacks";

/**
 * Scheduled cache warming + news ingestion.
 *
 * Vercel cron (see vercel.json) hits this daily. The handler runs three phases
 * in a deliberate order over the same rotating ticker slice:
 *
 * 1. **Market-cache warming** (whenever Polygon is present): primes the
 *    grouped-daily, market-snapshot, and year-ago caches via `warmMarketCaches()`
 *    so the homepage movers section is instant. Cheap (a few cached reads) and
 *    tagged "movers", so it's unaffected by the news revalidation in phase 2.
 *
 * 2. **News ingestion** (only when `hasLangflowIngest` is true): triggers
 *    Langflow/Gemini enrichment for the slice so popular tickers already have
 *    AI-enriched Astra rows before a user visits. This is the most valuable and
 *    only PERSISTENT work, so it runs before per-ticker warming — both to avoid
 *    being starved under a tight function timeout, and because it calls
 *    `revalidateTag("news")`, which would wipe a news warm done beforehand.
 *
 * 3. **Per-ticker warming** (whenever Polygon/Astra present): warms candles +
 *    fundamentals + the (now freshly-ingested) news READ cache via `warmTicker()`
 *    so detail pages are warm on a user's first visit. Runs sequentially to
 *    respect Polygon's free-tier rate limit. Self-gates internally (no-op +
 *    zero cost when credentials are absent).
 *
 * Auth: Vercel automatically attaches `Authorization: Bearer ${CRON_SECRET}` to
 * cron invocations when CRON_SECRET is set, so we reject anything else. This
 * also makes the endpoint safe to leave public (it no-ops without the secret).
 *
 * Coverage: rather than re-warming the same names daily, each run takes a
 * rotating slice of `CRON_WARMUP_TICKERS` keyed by the date, round-robin. With
 * a 30-name universe and 6 per run the whole list is refreshed every ~5 days,
 * spread across sectors, with zero concentration. Anything outside the list is
 * still covered on-demand the moment a user visits it.
 *
 * Cost safety: the shared `ingestTickerNews` keeps the same 6h per-ticker dedup
 * as the on-demand path, and we hard-cap the number of ingests per run so a
 * single invocation can never blow the Gemini free-tier budget (~20 req/day).
 * Cache warming hits are cheap cached reads after the first invocation.
 *
 * NOTE: On Vercel Pro, a second warm-only cron (e.g. every 6h) calling just
 * the warming portion would keep caches fresher with no Gemini cost — but Hobby
 * only allows one daily cron, so we fold everything into this single schedule.
 */

export const dynamic = "force-dynamic";
// Ingests run sequentially and each can take up to ~55s; give the function room
// (capped to the platform's plan limit). Lowered automatically on Hobby.
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Stay well under Gemini's free-tier daily quota, leaving headroom for the
// on-demand path. The 6h dedup means re-runs within a day are mostly no-ops.
const MAX_INGESTS_PER_RUN = 6;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Compute today's rotating ticker slice (shared by warming & ingestion) ──
  const universe = CRON_WARMUP_TICKERS;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const start = (dayIndex * MAX_INGESTS_PER_RUN) % universe.length;
  const tickers = Array.from(
    { length: Math.min(MAX_INGESTS_PER_RUN, universe.length) },
    (_, i) => universe[(start + i) % universe.length].ticker
  );

  // ── Phase 1: Warm shared market caches (homepage movers; tagged "movers"). ─
  await warmMarketCaches();

  // ── Phase 2: News ingestion (only when Langflow is configured). ────────────
  // Runs before per-ticker warming so the valuable, persistent Gemini work
  // isn't starved under a tight timeout, and so the news warm below captures
  // the freshly-ingested rows instead of being wiped by revalidateTag("news").
  let ingestResults: { ticker: string; ingested: boolean }[] | null = null;
  if (hasLangflowIngest) {
    ingestResults = [];
    for (const ticker of tickers) {
      const ingested = await ingestTickerNews(ticker);
      ingestResults.push({ ticker, ingested });
    }
  }

  // ── Phase 3: Warm per-ticker caches (candles, fundamentals, post-ingest
  // news), sequentially to respect Polygon's free-tier rate limit (~5 req/min).
  // Each call is internally best-effort (allSettled) and cost-gated.
  let warmed = 0;
  for (const ticker of tickers) {
    await warmTicker(ticker);
    warmed++;
  }

  return NextResponse.json({
    ok: true,
    warmed,
    attempted: ingestResults?.length ?? 0,
    ingested: ingestResults?.filter((r) => r.ingested).length ?? 0,
    results: ingestResults,
  });
}

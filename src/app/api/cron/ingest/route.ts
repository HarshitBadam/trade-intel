import { NextResponse } from "next/server";
import { hasLangflowIngest } from "@/lib/config";
import { ingestTickerNews } from "@/lib/news-ingest";
import { CRON_WARMUP_TICKERS } from "@/data/fallbacks";

/**
 * Scheduled news warm-up.
 *
 * Vercel cron (see vercel.json) hits this daily so popular tickers already have
 * AI-enriched Astra rows before a user visits — turning their first visit into a
 * `fresh` hit instead of an `analyzing` background ingest.
 *
 * Auth: Vercel automatically attaches `Authorization: Bearer ${CRON_SECRET}` to
 * cron invocations when CRON_SECRET is set, so we reject anything else. This
 * also makes the endpoint safe to leave public (it no-ops without the secret).
 *
 * Coverage: rather than re-warming the same names daily, each run takes a
 * rotating slice of `CRON_WARMUP_TICKERS` keyed by the date, round-robin. With
 * a 30-name universe and 6 ingests/run the whole list is refreshed every ~5
 * days, spread across sectors, with zero concentration. Anything outside the
 * list is still enriched on-demand the moment a user visits it.
 *
 * Cost safety: the shared `ingestTickerNews` keeps the same 6h per-ticker dedup
 * as the on-demand path, and we hard-cap the number of ingests per run so a
 * single invocation can never blow the Gemini free-tier budget (~20 req/day).
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

  if (!hasLangflowIngest) {
    return NextResponse.json({
      ok: true,
      skipped: "Langflow ingestion is not configured",
    });
  }

  // Rotate the slice by day so coverage round-robins through the whole universe
  // instead of repeating the same names. `dayIndex` advances once per calendar
  // day; multiplying by the run size walks a non-overlapping window forward.
  const universe = CRON_WARMUP_TICKERS;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const start = (dayIndex * MAX_INGESTS_PER_RUN) % universe.length;
  const tickers = Array.from(
    { length: Math.min(MAX_INGESTS_PER_RUN, universe.length) },
    (_, i) => universe[(start + i) % universe.length].ticker
  );

  // Sequential on purpose: concurrent Gemini calls trip the free-tier rate
  // limit. Each ticker self-dedupes (6h), so already-warm tickers return fast.
  const results: { ticker: string; ingested: boolean }[] = [];
  for (const ticker of tickers) {
    const ingested = await ingestTickerNews(ticker);
    results.push({ ticker, ingested });
  }

  return NextResponse.json({
    ok: true,
    attempted: results.length,
    ingested: results.filter((r) => r.ingested).length,
    results,
  });
}

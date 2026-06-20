import { NextResponse } from "next/server";
import { hasLangflowIngest } from "@/lib/config";
import { ingestTickerNews } from "@/lib/news-ingest";
import { warmMarketCaches, warmTicker } from "@/lib/market-data";
import { CRON_WARMUP_TICKERS } from "@/data/fallbacks";

export const dynamic = "force-dynamic";
// Each ingest can take ~55s; 300s gives room for the full sequential run.
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Caps Gemini usage well under the free-tier daily quota; 6h per-ticker dedup
// means re-runs within a day are mostly no-ops anyway.
const MAX_INGESTS_PER_RUN = 6;

export async function GET(request: Request) {
  // Vercel attaches Authorization: Bearer ${CRON_SECRET} automatically; reject
  // everything else so the public endpoint can't be triggered externally.
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const universe = CRON_WARMUP_TICKERS;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const start = (dayIndex * MAX_INGESTS_PER_RUN) % universe.length;
  const tickers = Array.from(
    { length: Math.min(MAX_INGESTS_PER_RUN, universe.length) },
    (_, i) => universe[(start + i) % universe.length].ticker
  );

  await warmMarketCaches();

  // Ingestion runs before per-ticker warming: it's the only persistent work,
  // and it calls revalidateTag("news") which would wipe a news warm done first.
  let ingestResults: { ticker: string; ingested: boolean }[] | null = null;
  if (hasLangflowIngest) {
    ingestResults = [];
    for (const ticker of tickers) {
      const ingested = await ingestTickerNews(ticker);
      ingestResults.push({ ticker, ingested });
    }
  }

  // Sequential to respect Polygon's free-tier rate limit (~5 req/min).
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

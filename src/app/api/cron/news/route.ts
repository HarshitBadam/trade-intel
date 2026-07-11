import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { hasUpstash } from "@/lib/config";
import { getUniverse } from "@/lib/market-data/universe";
import { loadTickerNews } from "@/lib/market-data/news-loaders";
import { maybeAnalyzeTicker } from "@/lib/market-data/analysis";
import { pruneOldArticles } from "@/lib/market-data/news-store";
import { rateLimit } from "@/lib/rate-limit";
import {
  breakerSnapshot,
  isOpen,
  recordFailure,
  recordSuccess,
} from "@/lib/breaker";

// One handler = the whole cron architecture: auth → durable-cursor batch →
// paced news lane → event-driven analysis pass → daily prune → JSON report.
// GH Actions hits it every ~5 min; the Vercel cron is a daily backstop.
//
// Run-budget math (must fit maxDuration = 300s):
//   Polygon news: ~5 req/min → NEWS_SPACING_MS 13s between calls.
//     Default B=8: 7×13s sleep + ~12s fetches ≈ 103s.
//   Groq 8B: ~6 000 TPM → one ~5k-token call ≈ 1/min → ANALYSIS_SPACING_MS 65s.
//     3 calls: 2×65s sleep + ~24s calls ≈ 154s. Cheap self-gated skips cost ~0.
//   Worst case 103 + 154 + ~2s prune ≈ 259s < 300s.
//   DEADLINE_MS (250s) soft-stops new paced work, leaving ~50s headroom.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

const NEWS_SPACING_MS = 13_000;
const ANALYSIS_SPACING_MS = 65_000;
// Soft deadline: stop starting new paced work with this much headroom remaining.
const DEADLINE_MS = 250_000;

// Ever-growing atomic counter; mod universe-length maps it back to [0, length).
const CURSOR_KEY = "cron:universe:cursor";
const PRUNE_CLAIM_S = 24 * 60 * 60;

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Process-local fallback for dev; prod uses the shared Upstash counter.
let memoryCursor = 0;

// INCRBY is atomic so two concurrent runs never own the same slice.
// Returns the START index this run owns (counter-after minus batchSize, mod length).
async function advanceCursor(
  batchSize: number,
  universeLength: number
): Promise<number> {
  if (hasUpstash) {
    try {
      const { Redis } = await import("@upstash/redis");
      const after = await Redis.fromEnv().incrby(CURSOR_KEY, batchSize);
      return (((after - batchSize) % universeLength) + universeLength) % universeLength;
    } catch (error) {
      console.error("[cron] cursor INCRBY failed, using in-memory cursor:", error);
    }
  }
  const start = ((memoryCursor % universeLength) + universeLength) % universeLength;
  memoryCursor += batchSize;
  return start;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const batchEnv = intEnv("CRON_BATCH_SIZE", 8, 1);
  const maxAnalyses = intEnv("CRON_MAX_ANALYSES", 3, 0);

  const universe = getUniverse();
  const universeLength = universe.length;

  // Halve the batch on weekends (UTC) to reduce provider calls on stale data.
  const utcDay = new Date().getUTCDay(); // 0 = Sun, 6 = Sat
  const isWeekend = utcDay === 0 || utcDay === 6;
  const batchSize = isWeekend ? Math.max(1, Math.floor(batchEnv / 2)) : batchEnv;

  const start = await advanceCursor(batchSize, universeLength);
  const batch = Array.from(
    { length: Math.min(batchSize, universeLength) },
    (_, i) => universe[(start + i) % universeLength].symbol
  );

  const loaded: { ticker: string; fetched: number; inserted: number }[] = [];
  const failed: string[] = [];
  // Skipped tickers still feed the analysis handoff — analysis reads stored
  // articles, so a stale-fetch ticker can still get a verdict this run.
  const skipped: string[] = [];

  let polygonDown = await isOpen("polygon");

  for (let i = 0; i < batch.length; i++) {
    const ticker = batch[i];
    if (polygonDown || elapsed() > DEADLINE_MS) {
      skipped.push(ticker);
      continue;
    }
    try {
      const result = await loadTickerNews(ticker);
      await recordSuccess("polygon");
      loaded.push({
        ticker: result.ticker,
        fetched: result.fetched,
        inserted: result.inserted,
      });
    } catch (error) {
      await recordFailure("polygon");
      failed.push(ticker);
      console.error(`[cron] news load failed for ${ticker}:`, error);
      if (await isOpen("polygon")) polygonDown = true;
    }
    if (i < batch.length - 1 && !polygonDown && elapsed() <= DEADLINE_MS) {
      await sleep(NEWS_SPACING_MS);
    }
  }

  // Freshly-loaded tickers first, then skipped; maybeAnalyzeTicker self-gates
  // (fresh / no-articles → cheap skip), so only real Groq calls count against
  // the cap and get the ANALYSIS_SPACING_MS delay.
  const analysis: { ticker: string; status: string; reason?: string }[] = [];
  const candidates = [...loaded.map((l) => l.ticker), ...skipped];
  let groqRuns = 0;
  let lastConsumedTpm = false;

  for (const ticker of candidates) {
    if (groqRuns >= maxAnalyses) break;
    if (elapsed() > DEADLINE_MS) break;
    // Space only between actual Groq calls (analyzed or error); cheap skips
    // are unspaced. Bail if the spacing itself would bust the deadline.
    if (lastConsumedTpm) {
      if (elapsed() + ANALYSIS_SPACING_MS > DEADLINE_MS) break;
      await sleep(ANALYSIS_SPACING_MS);
    }
    const status = await maybeAnalyzeTicker(ticker);
    const consumedTpm = status.status === "analyzed" || status.status === "error";
    analysis.push(
      status.status === "analyzed"
        ? { ticker, status: status.status }
        : { ticker, status: status.status, reason: status.reason }
    );
    if (consumedTpm) groqRuns += 1;
    lastConsumedTpm = consumedTpm;
  }

  // One invocation per day wins the claim and runs the retention delete.
  let pruned: number | null = null;
  const pruneClaim = await rateLimit("cron-prune", "daily", 1, PRUNE_CLAIM_S);
  if (pruneClaim.success) {
    try {
      pruned = await pruneOldArticles(90);
    } catch (error) {
      console.error("[cron] prune failed:", error);
    }
  }

  // Revalidate the "news" cache tag when new articles or a verdict landed.
  // When run via the ops script (outside a Next server) revalidateTag throws
  // its store-missing invariant — safe to swallow since there is no cache.
  const insertedArticles = loaded.some((l) => l.inserted > 0);
  const wroteVerdict = analysis.some((a) => a.status === "analyzed");
  if (insertedArticles || wroteVerdict) {
    try {
      revalidateTag("news");
    } catch {
      console.warn("[cron] revalidateTag skipped (no Next cache context)");
    }
  }

  return NextResponse.json({
    ok: true,
    cursor: { start, size: batchSize, universe: universeLength },
    news: { loaded, failed },
    analysis,
    pruned,
    elapsedMs: elapsed(),
    breakers: await breakerSnapshot([
      "polygon",
      "groq-analysis",
      "langflow-analysis",
    ]),
  });
}

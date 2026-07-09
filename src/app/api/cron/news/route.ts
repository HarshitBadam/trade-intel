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

// THE background lane (redesign §0/§7/§9). This one handler is the whole cron
// architecture, so it is meant to read top-to-bottom: auth, pick a batch off a
// durable cursor, load news (paced), hand successfully-touched tickers to the
// event-driven deep-analysis pass (self-gating, TPM-paced), prune once a day,
// and report everything as JSON. GH Actions hits it every ~5 min (the real
// cadence); the Vercel cron is a daily backstop.
//
// ─── Run-budget math (must fit maxDuration = 300s) ───────────────────────────
// Two providers with hard free-tier ceilings set the pace:
//   * Polygon news: ~5 req/min. We sleep NEWS_SPACING_MS (13s) BETWEEN calls,
//     so B tickers cost (B-1) x 13s of sleep. Default B=8 -> 7 x 13 = 91s, plus
//     ~1-2s per fetch (~12s) => news lane ~103s. 13s spacing = ~4.6/min, safely
//     under 5/min even with jitter.
//   * Groq 8B analysis: the binding limit is ~6,000 TOKENS/minute and Groq
//     counts max_tokens preflight, so one ~5k-token analysis call is ~1/min.
//     We space actual Groq-calling runs by ANALYSIS_SPACING_MS (65s) and cap
//     them at CRON_MAX_ANALYSES (default 3). 3 calls => 2 x 65s = 130s of sleep
//     plus ~8s/call (~24s) => analysis lane ~154s. Cheap self-gated skips
//     (fresh / no-articles) cost ~0 and are NOT spaced.
// Worst case 103 + 154 + ~2s prune ~= 259s < 300s. The DEADLINE_MS (250s) soft
// stop is the backstop: once elapsed approaches it we stop STARTING new paced
// work (no new fetch, no new analysis) and return what we have, leaving ~50s
// headroom for an in-flight call + prune + response.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Polygon 5/min: 13s between calls keeps us under it with jitter headroom.
const NEWS_SPACING_MS = 13_000;
// Groq ~6k TPM => ~1 analysis/min; 65s between actual analysis calls.
const ANALYSIS_SPACING_MS = 65_000;
// Soft stop: stop starting new paced work when we get this close to maxDuration.
const DEADLINE_MS = 250_000;

// Durable cursor key: an ever-growing counter advanced atomically per run.
const CURSOR_KEY = "cron:universe:cursor";
// Daily prune claim: 24h TTL, winner-runs-once across all invocations.
const PRUNE_CLAIM_S = 24 * 60 * 60;

// Reads knobs at request time (not import) so the ops script can set them via
// process.env before importing this module. Analyses may legitimately be 0
// (news-only run), so its floor is 0; the batch floor is 1.
function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-memory cursor for local dev without Upstash. Process-local, so it only
// advances within one process — good enough for a `run-cron` loop; prod uses
// the shared Upstash counter.
let memoryCursor = 0;

// Advance the cursor by batchSize and return the START index this run owns.
// Upstash INCRBY is atomic, so two overlapping runs never pick the same slice.
// INCRBY returns the counter AFTER adding, so the slice we own begins at
// (result - batchSize). mod length maps the unbounded counter back into
// [0, length) and makes wraparound automatic (the batch itself wraps with a
// per-index mod below).
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
  // Same Bearer CRON_SECRET contract as the old ingest route: Vercel attaches
  // it automatically, GH Actions sends it explicitly, everything else is 401.
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

  // Weekend throttle (§13.7): markets are closed, so halve the batch Sat/Sun
  // (UTC) to spend fewer provider calls on stale weekends.
  const utcDay = new Date().getUTCDay(); // 0 = Sun, 6 = Sat
  const isWeekend = utcDay === 0 || utcDay === 6;
  const batchSize = isWeekend ? Math.max(1, Math.floor(batchEnv / 2)) : batchEnv;

  const start = await advanceCursor(batchSize, universeLength);
  const batch = Array.from(
    { length: Math.min(batchSize, universeLength) },
    (_, i) => universe[(start + i) % universeLength].symbol
  );

  // ─── News lane ──────────────────────────────────────────────────────────
  const loaded: { ticker: string; fetched: number; inserted: number }[] = [];
  const failed: string[] = [];
  // Tickers we did NOT load this run (breaker open or deadline reached). They
  // still feed the analysis handoff — it works off STORED articles, so a stale
  // ticker can be refreshed even when its fetch was skipped.
  const skipped: string[] = [];

  // If Polygon is already tripped, skip the whole news lane; analysis can still
  // run on what's stored.
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
      // A failed ticker is recorded and skipped, never aborts the run.
      await recordFailure("polygon");
      failed.push(ticker);
      console.error(`[cron] news load failed for ${ticker}:`, error);
      // If that failure just tripped the breaker, abandon the rest of the lane.
      if (await isOpen("polygon")) polygonDown = true;
    }
    // Space Polygon calls, but not after the last one and not once we've given
    // up on the lane.
    if (i < batch.length - 1 && !polygonDown && elapsed() <= DEADLINE_MS) {
      await sleep(NEWS_SPACING_MS);
    }
  }

  // ─── Analysis handoff (D22, event-driven) ─────────────────────────────────
  // Freshly-loaded tickers first, then skipped batch tickers if capacity
  // remains. maybeAnalyzeTicker self-gates (fresh / no-articles skip with zero
  // Groq calls), so most of these are cheap; only actual Groq-calling runs
  // count against the cap and get the 65s TPM spacing.
  const analysis: { ticker: string; status: string; reason?: string }[] = [];
  const candidates = [...loaded.map((l) => l.ticker), ...skipped];
  let groqRuns = 0;
  let lastConsumedTpm = false;

  for (const ticker of candidates) {
    if (groqRuns >= maxAnalyses) break;
    if (elapsed() > DEADLINE_MS) break;
    // Space only BETWEEN actual Groq calls (analyzed OR error — both hit the
    // API and count against TPM), never after a cheap skip and never after the
    // last call. Bail if there's no room for the spacing plus a call.
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

  // ─── Prune lane (daily) ───────────────────────────────────────────────────
  // Winner of the 24h claim runs the single retention delete; everyone else
  // this day reports null. Uses the same one-shot rateLimit claim pattern.
  let pruned: number | null = null;
  const pruneClaim = await rateLimit("cron-prune", "daily", 1, PRUNE_CLAIM_S);
  if (pruneClaim.success) {
    try {
      pruned = await pruneOldArticles(90);
    } catch (error) {
      console.error("[cron] prune failed:", error);
    }
  }

  // Bust the store-first request-path caches (tag "news") when this run changed
  // anything a details page reads — new article rows landed OR a verdict was
  // (re)written. Without this the store-read unstable_cache would keep serving
  // the pre-run snapshot for up to its 10-min revalidate window. Best-effort:
  // under the terminal ops script (scripts/run-cron.ts) the handler runs outside
  // a Next server, revalidateTag throws its store-missing invariant, and there
  // is genuinely no cache to bust — so that failure is safe to swallow.
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
    breakers: await breakerSnapshot(["polygon", "groq", "langflow"]),
  });
}

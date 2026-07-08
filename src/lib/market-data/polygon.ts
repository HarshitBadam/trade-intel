import "server-only";

import { POLYGON_API_KEY } from "@/lib/config";

// Polygon's free tier allows 5 requests/minute per key. Bursting past that and
// retrying the resulting 429s spends the budget on failures: one cold page used
// to trigger a retry storm that starved every other call for minutes. Instead,
// every Polygon request queues for a token from a sliding-window budget, so
// calls are paced to what the key can actually sustain and 429s become the
// exception rather than the norm.
const WINDOW_MS = 60_000;
const BUDGET = Math.max(1, Number(process.env.POLYGON_RPM) || 5);

// A caller that cannot be served soon should fail fast into its honest
// fallback (daily chart, "unavailable" price/news state, hidden related
// section) rather than hang an SSR render or server action; the details page
// re-polls every 30s and fills the gaps once the budget replenishes.
const MAX_QUEUE_WAIT_MS = 15_000;

// One retry pass for a genuine 429 (e.g. another process sharing the key).
const MAX_RETRIES = 1;
const DEFAULT_PENALTY_MS = 15_000;
const MAX_PENALTY_MS = 30_000;

// "high" is for calls a user is actively waiting on (page price/chart/news,
// a clicked chart range); "low" is background enrichment (related-stock
// lookups, market maps, search). High jumps the queue so opening a second
// ticker isn't starved by the first ticker's background backfill.
export type PolygonPriority = "high" | "low";

type Waiter = {
  enqueuedAt: number;
  resolve: () => void;
  reject: (e: Error) => void;
};

const queues: Record<PolygonPriority, Waiter[]> = { high: [], low: [] };
const stamps: number[] = [];
let penaltyUntil = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function prune(now: number): void {
  while (stamps.length > 0 && stamps[0] <= now - WINDOW_MS) stamps.shift();
}

function queuedCount(): number {
  return queues.high.length + queues.low.length;
}

function budgetError(): Error {
  return new Error("polygon budget exhausted: queue wait limit exceeded");
}

function pump(): void {
  const now = Date.now();
  prune(now);

  // Backstop for estimate drift: nobody waits past the cap.
  for (const q of [queues.high, queues.low]) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (now - q[i].enqueuedAt > MAX_QUEUE_WAIT_MS) {
        q.splice(i, 1)[0].reject(budgetError());
      }
    }
  }

  while (queuedCount() > 0 && stamps.length < BUDGET && now >= penaltyUntil) {
    const w = (queues.high.shift() ?? queues.low.shift())!;
    stamps.push(now);
    w.resolve();
  }

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queuedCount() === 0) return;
  const wakeAt = Math.max(penaltyUntil, stamps[0] + WINDOW_MS);
  timer = setTimeout(pump, Math.max(25, wakeAt - Date.now()));
  // Don't hold the process open for the scheduler alone.
  timer.unref?.();
}

function acquireToken(priority: PolygonPriority): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const now = Date.now();
    prune(now);

    // Fail fast when this caller could not possibly be served within the wait
    // cap, given its queue position. High-priority calls only wait on other
    // high calls; low waits on everything.
    const ahead =
      priority === "high"
        ? queues.high.length
        : queues.high.length + queues.low.length;
    const free = Math.max(0, BUDGET - stamps.length);
    const needExpirations = ahead + 1 - free;
    let eta = now;
    if (needExpirations > 0) {
      eta =
        needExpirations <= stamps.length
          ? stamps[needExpirations - 1] + WINDOW_MS
          : now +
            WINDOW_MS +
            Math.ceil((needExpirations - stamps.length) / BUDGET) * WINDOW_MS;
    }
    eta = Math.max(eta, penaltyUntil);
    if (eta - now > MAX_QUEUE_WAIT_MS) {
      reject(budgetError());
      return;
    }

    queues[priority].push({ enqueuedAt: now, resolve, reject });
    pump();
  });
}

// GETs a Polygon endpoint through the shared budget. The final Response is
// returned as-is (ok or not) so callers keep their own status handling.
// Throws only when the queue wait cap would be exceeded.
export async function polygonFetch(
  url: string,
  opts?: { priority?: PolygonPriority }
): Promise<Response> {
  const priority = opts?.priority ?? "low";
  for (let attempt = 0; ; attempt++) {
    await acquireToken(priority);
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
    });
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response;

    // The whole key is rate-limited, not just this call: pause the pipeline.
    const retryAfter = Number(response.headers.get("retry-after"));
    const penaltyMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_PENALTY_MS)
        : DEFAULT_PENALTY_MS;
    penaltyUntil = Math.max(penaltyUntil, Date.now() + penaltyMs);
    // Drain the body so the retry reuses the socket.
    await response.arrayBuffer().catch(() => {});
  }
}

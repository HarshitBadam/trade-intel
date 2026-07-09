import "server-only";

import { POLYGON_API_KEY } from "@/lib/config";

// Minimal Polygon GET (redesign §16). The request-time news lane is gone —
// Polygon news now loads ONLY through the cron/priority store lanes — so the
// old sliding-window budget, priority queues, ETA rejection and penalty timers
// that existed to pace a shared 5/min key against user-facing news requests are
// deleted. The only remaining Polygon callers are the price/movers/detail
// FALLBACKS in cache.ts (used solely when Alpaca/Finnhub are absent or error),
// which are already cached hourly-to-daily and stay well inside the free tier.
//
// The Response is returned as-is (ok or not) on purpose: callers keep their own
// status handling — a 404 on ticker-detail means "no reference entry" (cache
// null), the grouped-daily walk-back distinguishes an empty OK day from an
// error, etc. Throwing here would erase those distinctions, so status stays the
// caller's job.
export async function polygonFetch(url: string): Promise<Response> {
  return fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
  });
}

import "server-only";

import { hasUpstash } from "./config";

/**
 * Rate limiting for expensive / billable server actions.
 *
 * Primary backend: Upstash Redis (works across serverless instances on Vercel).
 * Fallback: an in-memory sliding window. The fallback is per-instance only, so
 * it is best-effort under horizontal scaling — good enough for local dev and a
 * safety net in prod, but Upstash should be configured for real protection.
 */

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  /** epoch ms when the window resets */
  reset: number;
};

// ── In-memory fallback ──────────────────────────────────────────────────────
type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();

function memoryLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.reset <= now) {
    const reset = now + windowMs;
    buckets.set(key, { count: 1, reset });
    return { success: true, remaining: limit - 1, reset };
  }

  if (existing.count >= limit) {
    return { success: false, remaining: 0, reset: existing.reset };
  }

  existing.count += 1;
  return {
    success: true,
    remaining: limit - existing.count,
    reset: existing.reset,
  };
}

const MAX_BUCKETS = 10_000;

// Opportunistic cleanup so the map can't grow unbounded. First drop expired
// entries; if still over the hard cap (e.g. a flood of unique/spoofed keys),
// evict the soonest-to-reset entries so memory stays bounded and the instance
// cannot be OOM-crashed.
function sweep() {
  if (buckets.size < 5000) return;
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.reset <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].reset - b[1].reset);
    const toEvict = buckets.size - MAX_BUCKETS;
    for (let i = 0; i < toEvict; i++) buckets.delete(sorted[i][0]);
  }
}

// ── Upstash backend (lazy-loaded so it's free when unconfigured) ─────────────
let upstashLimiters: Map<string, unknown> | null = null;

async function upstashLimit(
  namespace: string,
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const { Ratelimit } = await import("@upstash/ratelimit");
  const { Redis } = await import("@upstash/redis");

  upstashLimiters ??= new Map();
  const cacheKey = `${namespace}:${limit}:${windowSec}`;
  let limiter = upstashLimiters.get(cacheKey) as
    | InstanceType<typeof Ratelimit>
    | undefined;

  if (!limiter) {
    limiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
      prefix: `ratelimit:${namespace}`,
      analytics: false,
    });
    upstashLimiters.set(cacheKey, limiter);
  }

  const res = await limiter.limit(key);
  return { success: res.success, remaining: res.remaining, reset: res.reset };
}

/**
 * Check (and consume) one unit against the limiter for `key`.
 *
 * @param namespace logical action name (e.g. "chat", "search")
 * @param key       caller identity (user id or IP)
 * @param limit     max requests per window
 * @param windowSec window length in seconds
 */
export async function rateLimit(
  namespace: string,
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const id = `${namespace}:${key}`;

  if (hasUpstash) {
    try {
      return await upstashLimit(namespace, key, limit, windowSec);
    } catch (error) {
      // Never let a limiter outage take down the action; fall back to memory.
      console.error("Upstash rate limit failed, using in-memory fallback:", error);
    }
  }

  sweep();
  return memoryLimit(id, limit, windowSec * 1000);
}

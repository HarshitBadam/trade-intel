import "server-only";

import { hasUpstash } from "../config";

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  resetAtMs: number;
};

type Bucket = { count: number; resetAtMs: number };
const buckets = new Map<string, Bucket>();

function memoryLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAtMs <= now) {
    const resetAtMs = now + windowMs;
    buckets.set(key, { count: 1, resetAtMs });
    return { success: true, remaining: limit - 1, resetAtMs };
  }

  if (existing.count >= limit) {
    return { success: false, remaining: 0, resetAtMs: existing.resetAtMs };
  }

  existing.count += 1;
  return {
    success: true,
    remaining: limit - existing.count,
    resetAtMs: existing.resetAtMs,
  };
}

const MAX_BUCKETS = 10_000;

// Evict expired entries then cap size to prevent OOM from unique-key floods.
function sweep() {
  if (buckets.size < 5000) return;
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAtMs <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) {
    const sorted = [...buckets.entries()].sort(
      (a, b) => a[1].resetAtMs - b[1].resetAtMs
    );
    const toEvict = buckets.size - MAX_BUCKETS;
    for (let i = 0; i < toEvict; i++) buckets.delete(sorted[i][0]);
  }
}

let upstashLimiters: Map<string, unknown> | null = null;
const UPSTASH_DEADLINE_MS = 500;
let lastUpstashWarningAt = 0;

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Upstash deadline exceeded (${timeoutMs}ms)`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  return {
    success: res.success,
    remaining: res.remaining,
    resetAtMs: res.reset,
  };
}

export async function rateLimit(
  namespace: string,
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const id = `${namespace}:${key}`;

  if (hasUpstash) {
    try {
      return await withDeadline(
        upstashLimit(namespace, key, limit, windowSec),
        UPSTASH_DEADLINE_MS
      );
    } catch (error) {
      if (Date.now() - lastUpstashWarningAt > 30_000) {
        lastUpstashWarningAt = Date.now();
        console.error(
          "Upstash rate limit unavailable; using in-memory fallback:",
          error
        );
      }
    }
  }

  sweep();
  return memoryLimit(id, limit, windowSec * 1000);
}

import "server-only";

import { hasUpstash } from "./config";

export type Provider =
  | "groq-analysis"
  | "tavily"
  | "astra";

const FAILURE_THRESHOLD = 3;

const OPEN_MS = 10 * 60 * 1000;
const OPEN_S = OPEN_MS / 1000;
const UNAVAILABLE_MS = 24 * 60 * 60 * 1000;
const UNAVAILABLE_S = UNAVAILABLE_MS / 1000;
const UPSTASH_DEADLINE_MS = 500;

type MemState = { fails: number; openUntil: number };
const memory = new Map<Provider, MemState>();
const cooldownMemory = new Map<Provider, number>();

function memState(provider: Provider): MemState {
  let state = memory.get(provider);
  if (!state) {
    state = { fails: 0, openUntil: 0 };
    memory.set(provider, state);
  }
  return state;
}

async function redis() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

async function withRedisDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Upstash deadline exceeded (${UPSTASH_DEADLINE_MS}ms)`)
            ),
          UPSTASH_DEADLINE_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function recordFailure(provider: Provider): Promise<void> {
  if (hasUpstash) {
    try {
      await withRedisDeadline(async () => {
        const r = await redis();
        const fails = await r.incr(`breaker:${provider}:fails`);
        await r.expire(`breaker:${provider}:fails`, OPEN_S);
        if (fails >= FAILURE_THRESHOLD) {
          await r.set(`breaker:${provider}:open`, 1, { ex: OPEN_S });
        }
      });
      return;
    } catch (error) {
      console.error(
        `[breaker] Upstash recordFailure failed for ${provider}, using memory:`,
        error
      );
    }
  }
  const state = memState(provider);
  state.fails += 1;
  if (state.fails >= FAILURE_THRESHOLD) state.openUntil = Date.now() + OPEN_MS;
}

// Configuration failures such as a provider returning "model not found" are
// not transient. Open the shared model lane immediately so every subsequent
// turn skips it instead of spending a request before reaching fallbacks.
export async function recordUnavailable(provider: Provider): Promise<void> {
  if (hasUpstash) {
    try {
      await withRedisDeadline(async () => {
        const r = await redis();
        await r.set(`breaker:${provider}:open`, 1, { ex: UNAVAILABLE_S });
      });
      return;
    } catch (error) {
      console.error(
        `[breaker] Upstash recordUnavailable failed for ${provider}, using memory:`,
        error
      );
    }
  }
  const state = memState(provider);
  state.fails = FAILURE_THRESHOLD;
  state.openUntil = Date.now() + UNAVAILABLE_MS;
}

export async function recordSuccess(provider: Provider): Promise<void> {
  if (hasUpstash) {
    try {
      await withRedisDeadline(async () => {
        const r = await redis();
        await r.del(`breaker:${provider}:fails`, `breaker:${provider}:open`);
      });
      return;
    } catch (error) {
      console.error(
        `[breaker] Upstash recordSuccess failed for ${provider}, using memory:`,
        error
      );
    }
  }
  const state = memState(provider);
  state.fails = 0;
  state.openUntil = 0;
}

export async function isOpen(provider: Provider): Promise<boolean> {
  if (hasUpstash) {
    try {
      const open = await withRedisDeadline(async () => {
        const r = await redis();
        return r.get(`breaker:${provider}:open`);
      });
      return open !== null && open !== undefined;
    } catch (error) {
      console.error(
        `[breaker] Upstash isOpen check failed for ${provider}, using memory:`,
        error
      );
    }
  }
  const state = memState(provider);
  if (state.openUntil > Date.now()) return true;
  if (state.openUntil !== 0) {
    state.openUntil = 0;
    state.fails = 0;
  }
  return false;
}

export async function recordCooldown(
  provider: Provider,
  durationMs: number
): Promise<void> {
  const ttlSeconds = Math.max(
    1,
    Math.min(60 * 60, Math.ceil(durationMs / 1000))
  );
  if (hasUpstash) {
    try {
      await withRedisDeadline(async () => {
        await (await redis()).set(`breaker:${provider}:cooldown`, 1, {
          ex: ttlSeconds,
        });
      });
      return;
    } catch (error) {
      console.error(
        `[breaker] Upstash cooldown failed for ${provider}, using memory:`,
        error
      );
    }
  }
  cooldownMemory.set(provider, Date.now() + ttlSeconds * 1000);
}

export async function isCoolingDown(provider: Provider): Promise<boolean> {
  if (hasUpstash) {
    try {
      const value = await withRedisDeadline(async () =>
        (await redis()).get(`breaker:${provider}:cooldown`)
      );
      return value !== null && value !== undefined;
    } catch (error) {
      console.error(
        `[breaker] Upstash cooldown check failed for ${provider}, using memory:`,
        error
      );
    }
  }
  const until = cooldownMemory.get(provider) ?? 0;
  if (until > Date.now()) return true;
  cooldownMemory.delete(provider);
  return false;
}

export function resetBreakerMemory(): void {
  memory.clear();
  cooldownMemory.clear();
}

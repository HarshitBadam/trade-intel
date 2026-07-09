import "server-only";

import { hasUpstash } from "./config";

// Minimal per-provider circuit breaker for the background lanes (redesign §13).
// The point is NOT resilience-theater — it is to stop a cron run from burning
// its whole budget hammering a provider that is already down (Polygon 5xx, Groq
// out of TPM). It trips after a short run of consecutive failures, stays open
// for a cooldown, then simply allows traffic again (half-open = "just try");
// the very next failure re-trips it. That is deliberately the crudest scheme
// that works, because a cron loop only needs "should I bother calling this?".
//
// Backed by Upstash when configured, with an in-memory fallback, mirroring
// rate-limit.ts: the breaker is best-effort, so a limiter outage must never be
// what takes the cron down. Keys are tiny (breaker:<provider>[:fails|:open]).

export type Provider = "polygon" | "groq" | "langflow";

// Trip after this many consecutive failures with no intervening success.
const FAILURE_THRESHOLD = 3;

// How long the breaker stays open before half-opening. ~10 min lines up with
// the cron cadence (GH Actions every 5 min): one or two runs skip the provider,
// then it gets probed again.
const OPEN_MS = 10 * 60 * 1000;
const OPEN_S = OPEN_MS / 1000;

// ─── In-memory fallback state ────────────────────────────────────────────────
// Process-local; fine for local dev / a single serverless instance. On Upstash
// the state is shared across instances, which is what actually matters in prod.
type MemState = { fails: number; openUntil: number };
const memory = new Map<Provider, MemState>();

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

// ─── Public API ──────────────────────────────────────────────────────────────

// Record a failed call. On the threshold-th consecutive failure the breaker
// opens for OPEN_S. Both keys share the same TTL so an idle breaker forgets its
// failure count on its own (they expire together), which keeps the fallback
// (memory) and Upstash paths behaving the same after a cooldown.
export async function recordFailure(provider: Provider): Promise<void> {
  if (hasUpstash) {
    try {
      const r = await redis();
      const fails = await r.incr(`breaker:${provider}:fails`);
      await r.expire(`breaker:${provider}:fails`, OPEN_S);
      if (fails >= FAILURE_THRESHOLD) {
        await r.set(`breaker:${provider}:open`, 1, { ex: OPEN_S });
      }
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

// Record a successful call: clears the failure streak and closes the breaker.
export async function recordSuccess(provider: Provider): Promise<void> {
  if (hasUpstash) {
    try {
      const r = await redis();
      await r.del(`breaker:${provider}:fails`, `breaker:${provider}:open`);
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

// True while the breaker is open. The open flag carries its own TTL, so
// half-open is implicit: once it expires this returns false again with no timer
// to manage. The memory path mirrors that by clearing state when the deadline
// passes.
export async function isOpen(provider: Provider): Promise<boolean> {
  if (hasUpstash) {
    try {
      const r = await redis();
      const open = await r.get(`breaker:${provider}:open`);
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
    // Cooldown elapsed — half-open: forget the streak so a fresh run of
    // failures is needed to trip again.
    state.openUntil = 0;
    state.fails = 0;
  }
  return false;
}

// Snapshot of each provider's state for the cron response (the prod diagnosis
// surface). Kept compact: just open/closed per provider.
export async function breakerSnapshot(
  providers: Provider[]
): Promise<Record<string, "open" | "closed">> {
  const out: Record<string, "open" | "closed"> = {};
  for (const provider of providers) {
    out[provider] = (await isOpen(provider)) ? "open" : "closed";
  }
  return out;
}

// Which backend the breaker is using — for ops output so a test can state
// whether it exercised the shared (Upstash) or process-local (memory) path.
export function breakerBackend(): "upstash" | "memory" {
  return hasUpstash ? "upstash" : "memory";
}

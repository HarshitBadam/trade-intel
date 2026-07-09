import "server-only";

import { hasUpstash } from "./config";

export type Provider = "polygon" | "groq" | "langflow";

const FAILURE_THRESHOLD = 3;

const OPEN_MS = 10 * 60 * 1000;
const OPEN_S = OPEN_MS / 1000;

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
    // Cooldown elapsed — half-open: reset the streak so re-tripping requires
    // a fresh run of failures rather than inheriting the old count.
    state.openUntil = 0;
    state.fails = 0;
  }
  return false;
}

export async function breakerSnapshot(
  providers: Provider[]
): Promise<Record<string, "open" | "closed">> {
  const out: Record<string, "open" | "closed"> = {};
  for (const provider of providers) {
    out[provider] = (await isOpen(provider)) ? "open" : "closed";
  }
  return out;
}

export function breakerBackend(): "upstash" | "memory" {
  return hasUpstash ? "upstash" : "memory";
}

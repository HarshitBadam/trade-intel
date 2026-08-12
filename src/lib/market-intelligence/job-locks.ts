import "server-only";

import {
  REFRESH_ACTIVE_MAX_TTL_SEC,
  TICKER_LOCK_LEASE_SEC,
} from "./job-store-types";
import {
  activeKey,
  currentTime,
  lockKey,
  memoryActive,
  memoryLocks,
  normalizeTicker,
  pruneMemory,
  redisClient,
  shouldUseRedis,
} from "./job-store-runtime";

export async function isActiveTickerOwner(
  tickerInput: string,
  workId: string
): Promise<boolean> {
  const ticker = normalizeTicker(tickerInput);
  if (!shouldUseRedis()) {
    pruneMemory();
    return memoryActive.get(ticker)?.workId === workId;
  }
  return (await (await redisClient()).get(activeKey(ticker))) === workId;
}

// Extending is owner-conditional and capped, so it cannot revive a reservation
// taken over by another job or pin a ticker forever after heartbeats stop.
export async function extendActiveReservation(
  tickerInput: string,
  workId: string,
  ttlSec: number
): Promise<boolean> {
  const ticker = normalizeTicker(tickerInput);
  const ttl = Math.max(
    1,
    Math.min(Math.ceil(ttlSec), REFRESH_ACTIVE_MAX_TTL_SEC)
  );
  if (!shouldUseRedis()) {
    pruneMemory();
    const active = memoryActive.get(ticker);
    if (!active || active.workId !== workId) return false;
    active.expiresAt = currentTime() + ttl * 1000;
    return true;
  }
  const client = await redisClient();
  const script = client.createScript<number>(
    `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end`
  );
  return (
    (await script.exec([activeKey(ticker)], [workId, String(ttl)])) === 1
  );
}

export async function acquireTickerLock(
  tickerInput: string,
  owner: string,
  leaseSec = TICKER_LOCK_LEASE_SEC
): Promise<boolean> {
  const ticker = normalizeTicker(tickerInput);
  if (!owner || leaseSec <= 0) return false;
  if (!shouldUseRedis()) {
    pruneMemory();
    if (memoryLocks.has(ticker)) return false;
    memoryLocks.set(ticker, {
      owner,
      expiresAt: currentTime() + leaseSec * 1000,
    });
    return true;
  }
  return (
    (await (await redisClient()).set(lockKey(ticker), owner, {
      nx: true,
      ex: leaseSec,
    })) === "OK"
  );
}

async function compareOwnerLock(
  tickerInput: string,
  owner: string,
  action: "renew" | "release",
  leaseSec = TICKER_LOCK_LEASE_SEC
): Promise<boolean> {
  const ticker = normalizeTicker(tickerInput);
  if (!shouldUseRedis()) {
    pruneMemory();
    const lock = memoryLocks.get(ticker);
    if (!lock || lock.owner !== owner) return false;
    if (action === "release") memoryLocks.delete(ticker);
    else lock.expiresAt = currentTime() + leaseSec * 1000;
    return true;
  }
  const client = await redisClient();
  const script = client.createScript<number>(
    action === "release"
      ? `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`
      : `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end`
  );
  return (
    (await script.exec(
      [lockKey(ticker)],
      action === "release" ? [owner] : [owner, String(leaseSec)]
    )) === 1
  );
}

export function renewTickerLock(
  ticker: string,
  owner: string,
  leaseSec = TICKER_LOCK_LEASE_SEC
): Promise<boolean> {
  return compareOwnerLock(ticker, owner, "renew", leaseSec);
}

export function releaseTickerLock(
  ticker: string,
  owner: string
): Promise<boolean> {
  return compareOwnerLock(ticker, owner, "release");
}

import "server-only";

import { randomUUID } from "node:crypto";
import {
  APP_URL,
  hasUpstash,
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
  QSTASH_TOKEN,
} from "@/lib/config";
import type { RefreshSource } from "./types";

export const REFRESH_ACTIVE_TTL_SEC = 15 * 60;
export const REFRESH_STATUS_TTL_SEC = 24 * 60 * 60;
export const TICKER_LOCK_LEASE_SEC = 90;
// Ceiling on the active-ticker reservation so an abandoned job (worker crash,
// dropped heartbeats) cannot pin a ticker forever; a fresh reservation is
// always possible once this elapses even without an explicit renewal.
export const REFRESH_ACTIVE_MAX_TTL_SEC = 45 * 60;

export type RefreshJobState = "queued" | "running" | "done" | "failed";

export type RefreshJob = {
  workId: string;
  ticker: string;
  state: RefreshJobState;
  requestedAt: string;
  source?: RefreshSource;
  startedAt?: string;
  completedAt?: string;
  retryAfter?: string;
  error?: string;
};

export type RefreshReservation = {
  job: RefreshJob;
  joined: boolean;
};

type MemoryEntry = {
  job: RefreshJob;
  expiresAt: number;
};

type ActiveEntry = {
  workId: string;
  expiresAt: number;
};

const memoryJobs = new Map<string, MemoryEntry>();
const memoryActive = new Map<string, ActiveEntry>();
const memoryLocks = new Map<string, { owner: string; expiresAt: number }>();

let now = () => Date.now();
let createWorkId: () => string = () => randomUUID();

const queueConfigured = Boolean(
  QSTASH_TOKEN &&
    APP_URL &&
    (QSTASH_CURRENT_SIGNING_KEY || QSTASH_NEXT_SIGNING_KEY)
);

function redisRequired(): boolean {
  return process.env.NODE_ENV === "production" || queueConfigured;
}

function shouldUseRedis(): boolean {
  if (redisRequired() && !hasUpstash) {
    throw new Error("The refresh queue requires Upstash Redis");
  }
  return hasUpstash && redisRequired();
}

async function redis() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

const prefix = "market-intelligence:refresh";
const jobKey = (workId: string) => `${prefix}:job:${workId}`;
const activeKey = (ticker: string) => `${prefix}:active:${ticker}`;
const lockKey = (ticker: string) => `${prefix}:lock:${ticker}`;

export function normalizeTicker(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(normalized)) {
    throw new Error("Invalid ticker");
  }
  return normalized;
}

function parseJob(value: unknown): RefreshJob | null {
  if (typeof value === "string") {
    try {
      return parseJob(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const job = value as Partial<RefreshJob>;
  if (
    typeof job.workId !== "string" ||
    typeof job.ticker !== "string" ||
    typeof job.requestedAt !== "string" ||
    !["queued", "running", "done", "failed"].includes(job.state ?? "")
  ) {
    return null;
  }
  return job as RefreshJob;
}

function pruneMemory(): void {
  const timestamp = now();
  for (const [key, entry] of memoryJobs) {
    if (entry.expiresAt <= timestamp) memoryJobs.delete(key);
  }
  for (const [key, entry] of memoryActive) {
    if (entry.expiresAt <= timestamp) memoryActive.delete(key);
  }
  for (const [key, entry] of memoryLocks) {
    if (entry.expiresAt <= timestamp) memoryLocks.delete(key);
  }
}

export async function reserveRefreshJob(
  tickerInput: string,
  source?: RefreshSource
): Promise<RefreshReservation> {
  const ticker = normalizeTicker(tickerInput);
  const workId = createWorkId();
  const requestedAt = new Date(now()).toISOString();
  const job: RefreshJob = {
    workId,
    ticker,
    state: "queued",
    requestedAt,
    ...(source ? { source } : {}),
  };

  if (!shouldUseRedis()) {
    pruneMemory();
    const active = memoryActive.get(ticker);
    if (active) {
      const existing = memoryJobs.get(active.workId)?.job;
      if (existing) return { job: { ...existing }, joined: true };
      memoryActive.delete(ticker);
    }
    memoryJobs.set(workId, {
      job,
      expiresAt: now() + REFRESH_STATUS_TTL_SEC * 1000,
    });
    memoryActive.set(ticker, {
      workId,
      expiresAt: now() + REFRESH_ACTIVE_TTL_SEC * 1000,
    });
    return { job: { ...job }, joined: false };
  }

  const client = await redis();
  const script = client.createScript<[string, number]>(`
    local existing = redis.call("GET", KEYS[1])
    if existing then
      local existingJob = redis.call("GET", "${prefix}:job:" .. existing)
      if existingJob then return {existingJob, 1} end
      redis.call("DEL", KEYS[1])
    end
    redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
    redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[4])
    return {ARGV[2], 0}
  `);
  const [stored, joined] = await script.exec(
    [activeKey(ticker), jobKey(workId)],
    [
      workId,
      JSON.stringify(job),
      String(REFRESH_ACTIVE_TTL_SEC),
      String(REFRESH_STATUS_TTL_SEC),
    ]
  );
  const parsed = parseJob(stored);
  if (!parsed) throw new Error("Redis returned an invalid refresh reservation");
  return { job: parsed, joined: joined === 1 };
}

export async function getRefreshJob(
  workId: string
): Promise<RefreshJob | null> {
  if (!shouldUseRedis()) {
    pruneMemory();
    const entry = memoryJobs.get(workId);
    return entry ? { ...entry.job } : null;
  }
  return parseJob(await (await redis()).get(jobKey(workId)));
}

async function transitionJob(
  workId: string,
  tickerInput: string,
  state: "running" | "done" | "failed",
  options: {
    error?: string;
    retryAfter?: string;
    // When set, the transition is fenced on `active:<ticker>` still pointing
    // at this workId. This lets terminal-failure finalization be claimed
    // exactly once and prevents a stale callback from mutating a job after a
    // newer reservation has taken over the ticker.
    requireActiveOwner?: boolean;
  } = {}
): Promise<RefreshJob | null> {
  const ticker = normalizeTicker(tickerInput);
  const timestamp = new Date(now()).toISOString();
  const retryAfterMs = Date.parse(options.retryAfter ?? "");
  const cooldownSec =
    state === "failed" && Number.isFinite(retryAfterMs) && retryAfterMs > now()
      ? Math.max(1, Math.ceil((retryAfterMs - now()) / 1000))
      : 0;

  if (!shouldUseRedis()) {
    pruneMemory();
    const entry = memoryJobs.get(workId);
    if (!entry || entry.job.ticker !== ticker) return null;
    if (entry.job.state === "done" || entry.job.state === "failed") {
      return options.requireActiveOwner ? null : { ...entry.job };
    }
    if (
      options.requireActiveOwner &&
      memoryActive.get(ticker)?.workId !== workId
    ) {
      return null;
    }
    entry.job = {
      ...entry.job,
      state,
      ...(state === "running" ? { startedAt: entry.job.startedAt ?? timestamp } : {}),
      ...(state !== "running" ? { completedAt: timestamp } : {}),
      ...(options.error ? { error: options.error } : {}),
      ...(options.retryAfter ? { retryAfter: options.retryAfter } : {}),
    };
    entry.expiresAt = now() + REFRESH_STATUS_TTL_SEC * 1000;
    if (state !== "running" && memoryActive.get(ticker)?.workId === workId) {
      if (state === "failed" && cooldownSec > 0) {
        memoryActive.set(ticker, {
          workId,
          expiresAt: now() + cooldownSec * 1000,
        });
      } else {
        memoryActive.delete(ticker);
      }
    }
    return { ...entry.job };
  }

  const client = await redis();
  const script = client.createScript<string | null>(`
    local raw = redis.call("GET", KEYS[1])
    if not raw then return nil end
    local job = cjson.decode(raw)
    if job["workId"] ~= ARGV[1] or job["ticker"] ~= ARGV[2] then return nil end
    if job["state"] == "done" or job["state"] == "failed" then
      if ARGV[9] == "1" then return nil else return raw end
    end
    if ARGV[9] == "1" then
      local activeOwner = redis.call("GET", KEYS[2])
      if activeOwner ~= ARGV[1] then return nil end
    end
    job["state"] = ARGV[3]
    if ARGV[3] == "running" then
      if not job["startedAt"] then job["startedAt"] = ARGV[4] end
    else
      job["completedAt"] = ARGV[4]
    end
    if ARGV[5] ~= "" then job["error"] = ARGV[5] end
    if ARGV[6] ~= "" then job["retryAfter"] = ARGV[6] end
    local updated = cjson.encode(job)
    redis.call("SET", KEYS[1], updated, "EX", ARGV[7])
    if ARGV[3] ~= "running" and redis.call("GET", KEYS[2]) == ARGV[1] then
      if ARGV[3] == "failed" and tonumber(ARGV[8]) > 0 then
        redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[8])
      else
        redis.call("DEL", KEYS[2])
      end
    end
    return updated
  `);
  const updated = await script.exec(
    [jobKey(workId), activeKey(ticker)],
    [
      workId,
      ticker,
      state,
      timestamp,
      options.error ?? "",
      options.retryAfter ?? "",
      String(REFRESH_STATUS_TTL_SEC),
      String(cooldownSec),
      options.requireActiveOwner ? "1" : "0",
    ]
  );
  return parseJob(updated);
}

export function markRefreshJobRunning(
  workId: string,
  ticker: string
): Promise<RefreshJob | null> {
  return transitionJob(workId, ticker, "running");
}

export function markRefreshJobDone(
  workId: string,
  ticker: string
): Promise<RefreshJob | null> {
  return transitionJob(workId, ticker, "done");
}

export function markRefreshJobFailed(
  workId: string,
  ticker: string,
  error: string,
  retryAfter?: string
): Promise<RefreshJob | null> {
  return transitionJob(workId, ticker, "failed", { error, retryAfter });
}

/**
 * Atomically claims terminal-failure finalization: the failed transition
 * only applies when the job is still nonterminal AND `active:<ticker>` still
 * points at this workId. Exactly one caller among a direct nonretryable
 * worker response and a QStash failure callback can win this race; the
 * other observes `null` and must no-op instead of re-running fallback
 * publication or degrading a result that a newer job already produced.
 */
export function claimTerminalFinalization(
  workId: string,
  ticker: string,
  error: string,
  retryAfter?: string
): Promise<RefreshJob | null> {
  return transitionJob(workId, ticker, "failed", {
    error,
    retryAfter,
    requireActiveOwner: true,
  });
}

/**
 * Read-only recheck of ticker ownership, used immediately before a fallback
 * CAS write so a late finalizer cannot publish over a ticker that a newer
 * reservation has already taken.
 */
export async function isActiveTickerOwner(
  tickerInput: string,
  workId: string
): Promise<boolean> {
  const ticker = normalizeTicker(tickerInput);
  if (!shouldUseRedis()) {
    pruneMemory();
    return memoryActive.get(ticker)?.workId === workId;
  }
  return (await (await redis()).get(activeKey(ticker))) === workId;
}

/**
 * Owner-conditionally extends the active-ticker reservation TTL. Used both
 * when a job is published with a showcase delay (so the reservation survives
 * until the worker actually runs) and from the worker heartbeat while a job
 * is running. The TTL is clamped so an abandoned job cannot pin a ticker
 * forever once heartbeats/renewals stop.
 */
export async function extendActiveReservation(
  tickerInput: string,
  workId: string,
  ttlSec: number
): Promise<boolean> {
  const ticker = normalizeTicker(tickerInput);
  const ttl = Math.max(1, Math.min(Math.ceil(ttlSec), REFRESH_ACTIVE_MAX_TTL_SEC));
  if (!shouldUseRedis()) {
    pruneMemory();
    const active = memoryActive.get(ticker);
    if (!active || active.workId !== workId) return false;
    active.expiresAt = now() + ttl * 1000;
    return true;
  }
  const client = await redis();
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
    memoryLocks.set(ticker, { owner, expiresAt: now() + leaseSec * 1000 });
    return true;
  }
  return (
    (await (await redis()).set(lockKey(ticker), owner, {
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
    else lock.expiresAt = now() + leaseSec * 1000;
    return true;
  }
  const client = await redis();
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

export function resetRefreshJobStoreForTests(options?: {
  now?: () => number;
  createWorkId?: () => string;
}): void {
  memoryJobs.clear();
  memoryActive.clear();
  memoryLocks.clear();
  now = options?.now ?? (() => Date.now());
  createWorkId = options?.createWorkId ?? (() => randomUUID());
}

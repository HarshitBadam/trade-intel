import "server-only";

import type { RefreshSource } from "./types";
import {
  REFRESH_ACTIVE_TTL_SEC,
  REFRESH_STATUS_TTL_SEC,
  type RefreshJob,
  type RefreshReservation,
} from "./job-store-types";
import {
  activeKey,
  currentTime,
  JOB_PREFIX,
  jobKey,
  memoryActive,
  memoryJobs,
  nextWorkId,
  normalizeTicker,
  parseJob,
  pruneMemory,
  redisClient,
  shouldUseRedis,
} from "./job-store-runtime";

export async function reserveRefreshJob(
  tickerInput: string,
  source?: RefreshSource
): Promise<RefreshReservation> {
  const ticker = normalizeTicker(tickerInput);
  const workId = nextWorkId();
  const job: RefreshJob = {
    workId,
    ticker,
    state: "queued",
    requestedAt: new Date(currentTime()).toISOString(),
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
      expiresAt: currentTime() + REFRESH_STATUS_TTL_SEC * 1000,
    });
    memoryActive.set(ticker, {
      workId,
      expiresAt: currentTime() + REFRESH_ACTIVE_TTL_SEC * 1000,
    });
    return { job: { ...job }, joined: false };
  }

  const client = await redisClient();
  const script = client.createScript<[string, number]>(`
    local existing = redis.call("GET", KEYS[1])
    if existing then
      local existingJob = redis.call("GET", "${JOB_PREFIX}:job:" .. existing)
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
  return parseJob(await (await redisClient()).get(jobKey(workId)));
}

type TransitionOptions = {
  error?: string;
  retryAfter?: string;
  requireActiveOwner?: boolean;
};

async function transitionJob(
  workId: string,
  tickerInput: string,
  state: "running" | "done" | "failed",
  options: TransitionOptions = {}
): Promise<RefreshJob | null> {
  const ticker = normalizeTicker(tickerInput);
  const timestamp = new Date(currentTime()).toISOString();
  const retryAfterMs = Date.parse(options.retryAfter ?? "");
  const cooldownSec =
    state === "failed" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > currentTime()
      ? Math.max(1, Math.ceil((retryAfterMs - currentTime()) / 1000))
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
      ...(state === "running"
        ? { startedAt: entry.job.startedAt ?? timestamp }
        : { completedAt: timestamp }),
      ...(options.error ? { error: options.error } : {}),
      ...(options.retryAfter ? { retryAfter: options.retryAfter } : {}),
    };
    entry.expiresAt = currentTime() + REFRESH_STATUS_TTL_SEC * 1000;
    if (state !== "running" && memoryActive.get(ticker)?.workId === workId) {
      if (state === "failed" && cooldownSec > 0) {
        memoryActive.set(ticker, {
          workId,
          expiresAt: currentTime() + cooldownSec * 1000,
        });
      } else {
        memoryActive.delete(ticker);
      }
    }
    return { ...entry.job };
  }

  const client = await redisClient();
  // The active-owner fence makes terminal finalization an exactly-once claim:
  // a stale callback cannot mutate state after a newer reservation takes over.
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

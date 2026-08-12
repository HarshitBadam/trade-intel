import "server-only";

import { randomUUID } from "node:crypto";
import {
  APP_URL,
  hasUpstash,
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
  QSTASH_TOKEN,
} from "@/lib/config";
import type {
  ActiveEntry,
  LockEntry,
  MemoryJobEntry,
  RefreshJob,
} from "./job-store-types";

export const memoryJobs = new Map<string, MemoryJobEntry>();
export const memoryActive = new Map<string, ActiveEntry>();
export const memoryLocks = new Map<string, LockEntry>();

export const JOB_PREFIX = "market-intelligence:refresh";
export const jobKey = (workId: string) => `${JOB_PREFIX}:job:${workId}`;
export const activeKey = (ticker: string) => `${JOB_PREFIX}:active:${ticker}`;
export const lockKey = (ticker: string) => `${JOB_PREFIX}:lock:${ticker}`;

let now = () => Date.now();
let createWorkId: () => string = () => randomUUID();

const queueConfigured = Boolean(
  QSTASH_TOKEN &&
    APP_URL &&
    (QSTASH_CURRENT_SIGNING_KEY || QSTASH_NEXT_SIGNING_KEY)
);

export function currentTime(): number {
  return now();
}

export function nextWorkId(): string {
  return createWorkId();
}

export function normalizeTicker(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(normalized)) {
    throw new Error("Invalid ticker");
  }
  return normalized;
}

export function shouldUseRedis(): boolean {
  const required = process.env.NODE_ENV === "production" || queueConfigured;
  if (required && !hasUpstash) {
    throw new Error("The refresh queue requires Upstash Redis");
  }
  return hasUpstash && required;
}

export async function redisClient() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

export function parseJob(value: unknown): RefreshJob | null {
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

export function pruneMemory(): void {
  const timestamp = currentTime();
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

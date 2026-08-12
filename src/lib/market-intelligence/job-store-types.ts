import type { RefreshSource } from "./types";

export const REFRESH_ACTIVE_TTL_SEC = 15 * 60;
export const REFRESH_STATUS_TTL_SEC = 24 * 60 * 60;
export const TICKER_LOCK_LEASE_SEC = 90;

// This ceiling ensures a crashed worker cannot pin a ticker indefinitely after
// heartbeats stop.
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

export type MemoryJobEntry = {
  job: RefreshJob;
  expiresAt: number;
};

export type ActiveEntry = {
  workId: string;
  expiresAt: number;
};

export type LockEntry = {
  owner: string;
  expiresAt: number;
};

import "server-only";

import {
  APP_URL,
  hasUpstash,
  MARKET_INTELLIGENCE_ON_DEMAND_DAILY_BUDGET,
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
  QSTASH_TOKEN,
  QSTASH_URL,
} from "@/lib/config";
import {
  extendActiveReservation,
  getRefreshJob,
  markRefreshJobFailed,
  reserveRefreshJob,
  type RefreshJob,
} from "./job-store";
import type { RefreshSource } from "./types";
import { recordMarketIntelligenceEvent } from "./telemetry";

export const REFRESH_WORKER_PATH = "/api/market-intelligence/worker";
export const REFRESH_FAILURE_PATH =
  "/api/market-intelligence/worker/failure";

// Worker route `maxDuration` (see worker/route.ts) plus headroom for the
// QStash retry schedule below (retryDelay * retries), so the active-ticker
// reservation cannot expire out from under a legitimately in-flight job
// before QStash exhausts its attempts.
const WORKER_MAX_DURATION_SEC = 300;
const QSTASH_RETRY_DELAY_SEC = 60;
const QSTASH_RETRIES = 2;
const QSTASH_RETRY_BUFFER_SEC = QSTASH_RETRY_DELAY_SEC * QSTASH_RETRIES + 60;

export const hasRefreshQueue = Boolean(
  QSTASH_TOKEN &&
    APP_URL &&
    (QSTASH_CURRENT_SIGNING_KEY || QSTASH_NEXT_SIGNING_KEY)
);

export type TickerRefreshPayload = {
  workId: string;
  ticker: string;
};

export type TickerRefreshRequest = RefreshJob & {
  joined: boolean;
  publish: "accepted" | "uncertain" | "suppressed";
};

type Publish = (
  payload: TickerRefreshPayload,
  delaySec?: number
) => Promise<void>;
let testPublisher: Publish | undefined;

async function consumeOnDemandBudget(): Promise<{
  success: boolean;
  retryAfter: string;
  errorCode?: string;
}> {
  if (testPublisher) {
    return { success: true, retryAfter: new Date().toISOString() };
  }
  if (!hasUpstash) {
    throw new Error("Durable on-demand admission requires Upstash Redis");
  }
  const { Redis } = await import("@upstash/redis");
  const client = Redis.fromEnv();
  const day = new Date().toISOString().slice(0, 10);
  const key = `market-intelligence:refresh:budget:${day}`;
  const script = client.createScript<[number, number]>(`
    local count = redis.call("INCR", KEYS[1])
    if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
    return {count, redis.call("TTL", KEYS[1])}
  `);
  const [count, ttl] = await script.exec([key], [String(24 * 60 * 60)]);
  return {
    success: count <= MARKET_INTELLIGENCE_ON_DEMAND_DAILY_BUDGET,
    retryAfter: new Date(
      Date.now() + Math.max(1, ttl) * 1000
    ).toISOString(),
    ...(count > MARKET_INTELLIGENCE_ON_DEMAND_DAILY_BUDGET
      ? { errorCode: "daily_budget_exhausted" }
      : {}),
  };
}

function destination(path: string): string {
  return `${APP_URL!.replace(/\/$/, "")}${path}`;
}

async function publish(
  payload: TickerRefreshPayload,
  delaySec?: number
): Promise<void> {
  if (testPublisher) return testPublisher(payload, delaySec);
  if (!hasRefreshQueue) {
    throw new Error("The market-intelligence refresh queue is not configured");
  }
  const { Client } = await import("@upstash/qstash");
  const client = new Client({
    token: QSTASH_TOKEN!,
    ...(QSTASH_URL ? { baseUrl: QSTASH_URL.replace(/\/$/, "") } : {}),
  });
  await client.publishJSON({
    url: destination(REFRESH_WORKER_PATH),
    body: payload,
    retries: QSTASH_RETRIES,
    // Fixed, sane retry spacing (rather than QStash's default exponential
    // backoff) keeps the worst-case delivery window predictable so the
    // active-ticker reservation TTL above can be sized to cover it.
    retryDelay: String(QSTASH_RETRY_DELAY_SEC * 1000),
    deduplicationId: payload.workId,
    failureCallback: destination(REFRESH_FAILURE_PATH),
    ...(delaySec && delaySec > 0 ? { delay: delaySec } : {}),
  });
}

/**
 * A publish response can be lost even though QStash received the request.
 * Rather than treat that ambiguity as failure, make one bounded immediate
 * retry using the same workId/deduplication id: if the first attempt did
 * land, QStash dedupes the retry; if it did not, this attempt is the first
 * real delivery. Only if both attempts throw do we surface "uncertain" and
 * preserve honest state for the caller instead of minting a new workId or
 * falling back to synchronous work.
 */
async function publishWithBoundedRetry(
  payload: TickerRefreshPayload,
  delaySec?: number
): Promise<boolean> {
  try {
    await publish(payload, delaySec);
    return true;
  } catch {
    try {
      await publish(payload, delaySec);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Reserves one active job per normalized ticker and hands it to QStash.
 * A publish exception is deliberately not terminal: the request may have
 * reached QStash before the response was lost. Retrying joins this workId and
 * uses the same QStash deduplication id.
 */
export async function requestTickerRefresh(
  ticker: string,
  source: RefreshSource = "user_request",
  delaySec?: number
): Promise<TickerRefreshRequest> {
  if (!hasRefreshQueue && !testPublisher) {
    throw new Error("The market-intelligence refresh queue is not configured");
  }
  const reservation = await reserveRefreshJob(ticker, source);
  if (reservation.joined && reservation.job.state === "failed") {
    recordMarketIntelligenceEvent("refresh_suppressed", {
      ticker: reservation.job.ticker,
      reason: reservation.job.error ?? "cooldown",
    });
    return {
      ...reservation.job,
      joined: true,
      publish: "suppressed",
    };
  }
  if (!reservation.joined && source === "user_request") {
    let admission: Awaited<ReturnType<typeof consumeOnDemandBudget>>;
    try {
      admission = await consumeOnDemandBudget();
    } catch {
      admission = {
        success: false,
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "admission_unavailable",
      };
    }
    if (!admission.success) {
      const failed =
        (await markRefreshJobFailed(
          reservation.job.workId,
          reservation.job.ticker,
          admission.errorCode ?? "admission_unavailable",
          admission.retryAfter
        )) ?? reservation.job;
      recordMarketIntelligenceEvent("refresh_suppressed", {
        ticker: reservation.job.ticker,
        reason: admission.errorCode ?? "admission_unavailable",
      });
      return {
        ...failed,
        joined: false,
        publish: "suppressed",
      };
    }
  }
  // Size the active-ticker reservation for the worst case this publish can
  // still complete under: any showcase delay, the worker's own execution
  // budget, and QStash's configured retry schedule. Owner-conditional, so it
  // only ever extends this job's own reservation.
  await extendActiveReservation(
    reservation.job.ticker,
    reservation.job.workId,
    (delaySec ?? 0) + WORKER_MAX_DURATION_SEC + QSTASH_RETRY_BUFFER_SEC
  ).catch(() => false);

  const delivered = await publishWithBoundedRetry(
    {
      workId: reservation.job.workId,
      ticker: reservation.job.ticker,
    },
    delaySec
  );
  if (delivered) {
    recordMarketIntelligenceEvent(
      reservation.joined ? "refresh_joined" : "refresh_queued",
      {
        ticker: reservation.job.ticker,
        source,
        delayedSec: delaySec ?? 0,
      }
    );
    return {
      ...reservation.job,
      joined: reservation.joined,
      publish: "accepted",
    };
  }
  recordMarketIntelligenceEvent("refresh_publish_uncertain", {
    ticker: reservation.job.ticker,
    source,
  });
  return {
    ...reservation.job,
    joined: reservation.joined,
    publish: "uncertain",
  };
}

export async function getTickerRefreshStatus(
  workId: string
): Promise<RefreshJob | null> {
  return getRefreshJob(workId);
}

export function parseTickerRefreshPayload(
  value: unknown
): TickerRefreshPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<TickerRefreshPayload>;
  if (
    typeof payload.workId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.workId
    ) ||
    typeof payload.ticker !== "string"
  ) {
    return null;
  }
  const ticker = payload.ticker.trim().toUpperCase();
  if (ticker !== payload.ticker || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) {
    return null;
  }
  return { workId: payload.workId, ticker };
}

export function setRefreshPublisherForTests(
  publisher?: Publish
): void {
  testPublisher = publisher;
}

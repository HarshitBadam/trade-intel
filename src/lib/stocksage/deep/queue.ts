import "server-only";

import {
  APP_URL,
  hasDeepQueue,
  QSTASH_TOKEN,
  QSTASH_URL,
} from "@/lib/config";
import { LATENCY_BUDGET_MS } from "../budget";
import {
  deepResearchAttemptIdentity,
  parseDeepResearchSnapshot,
  reissueDeepResearchSnapshot,
} from "./snapshot";
import {
  acceptDeepWork,
  failAcceptedDeepWork,
  readDeepWorkStatus,
  type DeepWorkStatus,
} from "./store";
import { logStockSage } from "../telemetry";
import type { DeepResearchReply } from "../types";

export const DEEP_WORKER_PATH = "/api/stocksage/deep";

export type DeepResearchJob =
  | { status: "pending"; workId: string }
  | { status: "success" | "failure"; reply: DeepResearchReply };

const INVALID_TOKEN: DeepResearchReply = {
  workId: "invalid",
  status: "failure",
  text: "Open Research deeper from the latest StockSage answer.",
};

async function publish(args: {
  token: string;
  workId: string;
  attemptId: string;
}): Promise<boolean> {
  const { Client } = await import("@upstash/qstash");
  const client = new Client({
    token: QSTASH_TOKEN!,
    ...(QSTASH_URL ? { baseUrl: QSTASH_URL.replace(/\/$/, "") } : {}),
  });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    LATENCY_BUDGET_MS.deep_enqueue
  );
  try {
    await client.publishJSON({
      url: `${APP_URL!.replace(/\/$/, "")}${DEEP_WORKER_PATH}`,
      body: {
        token: args.token,
        workId: args.workId,
        attemptId: args.attemptId,
      },
      retries: 1,
      deduplicationId: `${args.workId}:${args.attemptId}`,
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hands Deep Research to the queue and returns immediately. When the queue is
 * not configured, or publishing fails, no provider work runs in this request.
 */
export async function enqueueDeepResearch(
  token: unknown
): Promise<DeepResearchJob> {
  const snapshot = parseDeepResearchSnapshot(token);
  if (!snapshot) return { status: "failure", reply: INVALID_TOKEN };
  const identity = deepResearchAttemptIdentity(snapshot);

  const existing = await readDeepWorkStatus(snapshot.workId).catch(
    (): DeepWorkStatus => ({ state: "unknown" })
  );
  if (existing.state === "done") {
    return { status: existing.reply.status, reply: existing.reply };
  }
  if (existing.state === "pending") {
    return { status: "pending", workId: snapshot.workId };
  }

  const startedAt = Date.now();
  const unavailable: DeepResearchReply = {
    workId: snapshot.workId,
    status: "failure",
    text: hasDeepQueue
      ? "Research deeper could not be queued. The answer above remains the supported view."
      : "Research deeper is unavailable right now. The answer above remains the supported view.",
    retryable: true,
  };
  try {
    const acceptance = await acceptDeepWork({
      identity,
      responseId: snapshot.responseId,
      expiresAt: snapshot.expiresAt,
    });
    if (!acceptance.created) {
      // The NX conflict winner is authoritative. Reconcile its accepted
      // deadline/running lease before joining so stale work is never exposed
      // as pending, and never publish a second delivery for the same attempt.
      const joined = await readDeepWorkStatus(acceptance.workId).catch(
        (): DeepWorkStatus => ({ state: "unknown" })
      );
      if (joined.state === "done") {
        return { status: joined.reply.status, reply: joined.reply };
      }
      if (joined.state === "pending") {
        return { status: "pending", workId: acceptance.workId };
      }
      return { status: "failure", reply: unavailable };
    }
    const published =
      hasDeepQueue &&
      (await publish({
        token: token as string,
        workId: identity.workId,
        attemptId: identity.attemptId,
      }));
    logStockSage({
      event: "deep_enqueue",
      latencyClass: "deep_enqueue",
      durationMs: Date.now() - startedAt,
      reasonCode: published
        ? "queued"
        : hasDeepQueue
          ? "publish_failed"
          : "queue_unavailable",
    });
    if (published) {
      // Publishing is not itself proof that an accepted window or worker lease
      // is still live. Reconcile once more before exposing pending.
      const queued = await readDeepWorkStatus(snapshot.workId).catch(
        (): DeepWorkStatus => ({ state: "unknown" })
      );
      if (queued.state === "done") {
        return { status: queued.reply.status, reply: queued.reply };
      }
      if (queued.state === "pending") {
        return { status: "pending", workId: snapshot.workId };
      }
      return { status: "failure", reply: unavailable };
    }
    await failAcceptedDeepWork({
      identity,
      reply: unavailable,
      responseId: snapshot.responseId,
      expiresAt: snapshot.expiresAt,
    });
    return { status: "failure", reply: unavailable };
  } catch {
    await failAcceptedDeepWork({
      identity,
      reply: unavailable,
      responseId: snapshot.responseId,
      expiresAt: snapshot.expiresAt,
    }).catch(() => undefined);
    return { status: "failure", reply: unavailable };
  }
}

/** Polling entry point used by the client while a queued job runs. */
export async function getDeepResearchStatus(
  workId: string
): Promise<DeepResearchJob> {
  const status = await readDeepWorkStatus(workId).catch(
    (): DeepWorkStatus => ({ state: "unknown" })
  );
  if (status.state === "done") {
    return { status: status.reply.status, reply: status.reply };
  }
  if (status.state === "pending") return { status: "pending", workId };
  return {
    status: "failure",
    reply: {
      workId,
      status: "failure",
      text: "That deeper pass is no longer running. The answer above remains the supported view; start a new pass from it.",
      retryable: true,
    },
  };
}

/**
 * Server-side retry validates the old signature, freezes the same context into
 * a fresh v2 token, and publishes a new work/attempt/deduplication identity.
 */
export async function retryDeepResearch(
  token: unknown
): Promise<DeepResearchJob> {
  const snapshot = parseDeepResearchSnapshot(token);
  if (!snapshot) return { status: "failure", reply: INVALID_TOKEN };
  const reissued = reissueDeepResearchSnapshot(snapshot);
  return enqueueDeepResearch(reissued.token);
}

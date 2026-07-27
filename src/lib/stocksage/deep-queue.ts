import "server-only";

import {
  APP_URL,
  hasDeepQueue,
  QSTASH_TOKEN,
  QSTASH_URL,
} from "@/lib/config";
import { LATENCY_BUDGET_MS } from "./budget";
import { runDeepResearch } from "./deep";
import { parseDeepResearchSnapshot } from "./deep-snapshot";
import {
  markDeepWorkAccepted,
  readDeepWorkStatus,
  type DeepWorkStatus,
} from "./deep-store";
import { logStockSage } from "./telemetry";
import type { DeepResearchReply } from "./types";

export const DEEP_WORKER_PATH = "/api/stocksage/deep";

export type DeepResearchJob =
  | { status: "pending"; workId: string }
  | { status: "success" | "failure"; reply: DeepResearchReply };

const INVALID_TOKEN: DeepResearchReply = {
  workId: "invalid",
  status: "failure",
  text: "Open Research deeper from the latest StockSage answer.",
};

async function publish(token: string, workId: string): Promise<boolean> {
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
      body: { token, workId },
      retries: 1,
      // The worker is idempotent by workId, so QStash de-duplicating repeat
      // clicks is a bonus rather than the thing correctness depends on.
      deduplicationId: workId,
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
 * not configured, or publishing fails, the previous synchronous behavior runs
 * instead so this phase stays reversible.
 */
export async function enqueueDeepResearch(
  token: unknown
): Promise<DeepResearchJob> {
  const snapshot = parseDeepResearchSnapshot(token);
  if (!snapshot) return { status: "failure", reply: INVALID_TOKEN };

  const existing = await readDeepWorkStatus(snapshot.workId).catch(
    (): DeepWorkStatus => ({ state: "unknown" })
  );
  if (existing.state === "done") {
    return { status: existing.reply.status, reply: existing.reply };
  }
  if (existing.state === "pending") {
    return { status: "pending", workId: snapshot.workId };
  }

  if (hasDeepQueue) {
    const startedAt = Date.now();
    await markDeepWorkAccepted(snapshot.workId);
    const published = await publish(token as string, snapshot.workId);
    logStockSage({
      event: "deep_enqueue",
      latencyClass: "deep_enqueue",
      durationMs: Date.now() - startedAt,
      reasonCode: published ? "queued" : "publish_failed",
    });
    if (published) return { status: "pending", workId: snapshot.workId };
  }

  const reply = await runDeepResearch(token);
  return { status: reply.status, reply };
}

/** Polling entry point used by the client while a queued job runs. */
export async function pollDeepResearch(
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

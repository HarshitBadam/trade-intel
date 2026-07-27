import "server-only";

import { z } from "zod";
import { hasUpstash } from "@/lib/config";
import type { DeepResearchReply } from "./types";

const ResultSchema = z.object({
  workId: z.string().uuid(),
  status: z.enum(["success", "failure"]),
  text: z.string().optional(),
  citationUrls: z.array(z.string()).optional(),
  retryable: z.boolean().optional(),
});

const pending = new Map<string, Promise<DeepResearchReply>>();
const completed = new Map<string, DeepResearchReply>();

async function redis() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

async function readRedisResult(
  workId: string
): Promise<DeepResearchReply | null> {
  const value = await (await redis()).get(`stocksage:deep:result:${workId}`);
  const parsed = ResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function runWithRedis(
  workId: string,
  task: () => Promise<DeepResearchReply>
): Promise<DeepResearchReply> {
  const existing = await readRedisResult(workId);
  if (existing) return existing;
  const client = await redis();
  const lockKey = `stocksage:deep:lock:${workId}`;
  const acquired = await client.set(lockKey, "1", { nx: true, ex: 90 });
  if (!acquired) {
    for (let attempt = 0; attempt < 70; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await readRedisResult(workId);
      if (result) return result;
    }
    return {
      workId,
      status: "failure",
      text: "The deeper evidence pass is in progress. Keep this answer open and select Research deeper again.",
      retryable: true,
    };
  }
  try {
    const result = await task();
    if (result.status === "success" || !result.retryable) {
      await client
        .set(`stocksage:deep:result:${workId}`, result, {
          ex: 24 * 60 * 60,
        })
        .catch(() => undefined);
    }
    return result;
  } finally {
    await client.del(lockKey).catch(() => undefined);
  }
}

export async function runIdempotentDeepWork(
  workId: string,
  task: () => Promise<DeepResearchReply>
): Promise<DeepResearchReply> {
  const done = completed.get(workId);
  if (done) return done;
  const running = pending.get(workId);
  if (running) return running;
  const work = (async () => {
    let result: DeepResearchReply;
    if (hasUpstash) {
      let taskStarted = false;
      try {
        result = await runWithRedis(workId, () => {
          taskStarted = true;
          return task();
        });
      } catch {
        result = taskStarted
          ? {
              workId,
              status: "failure",
              text: "The answer above remains the supported view. Start a new Research deeper pass from that answer.",
              retryable: true,
            }
          : await task();
      }
    } else {
      result = await task();
    }
    if (result.status === "success" || !result.retryable) {
      completed.set(workId, result);
      if (completed.size > 500) {
        completed.delete(completed.keys().next().value as string);
      }
    }
    return result;
  })();
  pending.set(workId, work);
  try {
    return await work;
  } finally {
    pending.delete(workId);
  }
}

export function resetDeepWorkMemory(): void {
  pending.clear();
  completed.clear();
  accepted.clear();
}

/** Work handed to the queue but not yet finished, so polling can say so. */
const accepted = new Set<string>();

const ACCEPTED_TTL_SEC = 15 * 60;

export async function markDeepWorkAccepted(workId: string): Promise<void> {
  accepted.add(workId);
  if (!hasUpstash) return;
  await (await redis())
    .set(`stocksage:deep:accepted:${workId}`, "1", { ex: ACCEPTED_TTL_SEC })
    .catch(() => undefined);
}

export type DeepWorkStatus =
  | { state: "unknown" }
  | { state: "pending" }
  | { state: "done"; reply: DeepResearchReply };

/**
 * Polling view of a job. It reads the same keys the worker writes, so an
 * asynchronous result and a synchronous one are indistinguishable to callers.
 */
export async function readDeepWorkStatus(
  workId: string
): Promise<DeepWorkStatus> {
  const done = completed.get(workId);
  if (done) return { state: "done", reply: done };
  if (hasUpstash) {
    const stored = await readRedisResult(workId).catch(() => null);
    if (stored) return { state: "done", reply: stored };
    const inFlight = await (await redis())
      .get(`stocksage:deep:accepted:${workId}`)
      .catch(() => null);
    if (inFlight) return { state: "pending" };
  }
  if (pending.has(workId) || accepted.has(workId)) return { state: "pending" };
  return { state: "unknown" };
}

/** Called by the worker so a completed job stops looking in-flight. */
export async function clearDeepWorkAccepted(workId: string): Promise<void> {
  accepted.delete(workId);
  if (!hasUpstash) return;
  await (await redis())
    .del(`stocksage:deep:accepted:${workId}`)
    .catch(() => undefined);
}

/** Persists a worker result so later polls and repeat clicks reuse it. */
export async function storeDeepWorkResult(
  reply: DeepResearchReply
): Promise<void> {
  if (reply.status !== "success" && reply.retryable) return;
  completed.set(reply.workId, reply);
  if (!hasUpstash) return;
  await (await redis())
    .set(`stocksage:deep:result:${reply.workId}`, reply, {
      ex: 24 * 60 * 60,
    })
    .catch(() => undefined);
}

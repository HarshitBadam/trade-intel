import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasUpstash } from "@/lib/config";
import type { DeepResearchAttemptIdentity } from "./snapshot";
import type { DeepResearchReply } from "../types";

const ReplySchema = z.object({
  workId: z.string().uuid(),
  status: z.enum(["success", "failure"]),
  text: z.string().optional(),
  citationUrls: z.array(z.string()).optional(),
  retryable: z.boolean().optional(),
});

const JobSchema = z.object({
  version: z.literal(1),
  workId: z.string().uuid(),
  attemptId: z.string().uuid(),
  attempt: z.number().int().min(1),
  responseId: z.string().uuid(),
  state: z.enum(["accepted", "running", "succeeded", "failed"]),
  acceptedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  leaseOwner: z.string().uuid().optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  leaseExpiresAtMs: z.number().int().optional(),
  expiresAt: z.string().datetime(),
  reply: ReplySchema.optional(),
});

export type DeepWorkRecord = z.infer<typeof JobSchema>;
export type DeepWorkAcceptance = DeepWorkRecord & { created: boolean };

const jobs = new Map<string, DeepWorkRecord>();
const pending = new Map<string, Promise<DeepResearchReply>>();
let testDurableStatusReader:
  | ((workId: string) => Promise<DeepWorkRecord | null>)
  | undefined;
const TERMINAL_TTL_SEC = 24 * 60 * 60;
const DEFAULT_LEASE_MS = 125_000;
export const DEEP_TERMINAL_DEADLINE_MS = 120_000;

async function redis() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

function key(workId: string): string {
  return `stocksage:deep:job:v1:${workId}`;
}

function parseRecord(value: unknown): DeepWorkRecord | null {
  try {
    const parsed = JobSchema.safeParse(
      typeof value === "string" ? JSON.parse(value) : value
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readRedisRecord(workId: string): Promise<DeepWorkRecord | null> {
  return parseRecord(await (await redis()).get(key(workId)));
}

function remember(record: DeepWorkRecord): void {
  jobs.set(record.workId, record);
  if (jobs.size > 500) jobs.delete(jobs.keys().next().value as string);
}

export async function acceptDeepWork(args: {
  identity: DeepResearchAttemptIdentity;
  responseId: string;
  expiresAt: string;
  now?: Date;
}): Promise<DeepWorkAcceptance> {
  const now = (args.now ?? new Date()).toISOString();
  const record: DeepWorkRecord = {
    version: 1,
    ...args.identity,
    responseId: args.responseId,
    state: "accepted",
    acceptedAt: now,
    updatedAt: now,
    expiresAt: args.expiresAt,
  };
  if (hasUpstash) {
    const client = await redis();
    const created = await client.set(key(record.workId), JSON.stringify(record), {
      nx: true,
      ex: TERMINAL_TTL_SEC,
    });
    if (!created) {
      const existing = await readRedisRecord(record.workId);
      if (existing) {
        remember(existing);
        return { ...existing, created: false };
      }
      throw new Error("Deep Research acceptance conflict");
    }
    // A successful durable create is authoritative. Never let a stale record
    // from this process shadow the record Redis just accepted.
    remember(record);
    return { ...record, created: true };
  }
  const existing = jobs.get(record.workId);
  if (existing) return { ...existing, created: false };
  remember(record);
  return { ...record, created: true };
}

const CLAIM_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local job = cjson.decode(raw)
if job.attemptId ~= ARGV[1] then return nil end
if job.state ~= "accepted" then return nil end
if job.acceptedAt <= ARGV[2] then return nil end
job.state = "running"
job.startedAt = job.startedAt or ARGV[3]
job.updatedAt = ARGV[3]
job.leaseOwner = ARGV[4]
job.leaseExpiresAt = ARGV[5]
job.leaseExpiresAtMs = tonumber(ARGV[6])
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded, "EX", ARGV[7])
return encoded
`;

export async function claimDeepWork(args: {
  identity: DeepResearchAttemptIdentity;
  owner: string;
  leaseMs?: number;
  now?: Date;
}): Promise<DeepWorkRecord | null> {
  const now = args.now ?? new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + (args.leaseMs ?? DEFAULT_LEASE_MS)
  ).toISOString();
  if (hasUpstash) {
    const value = await (await redis()).eval(CLAIM_SCRIPT, [key(args.identity.workId)], [
      args.identity.attemptId,
      new Date(
        now.getTime() - DEEP_TERMINAL_DEADLINE_MS
      ).toISOString(),
      now.toISOString(),
      args.owner,
      leaseExpiresAt,
      String(Date.parse(leaseExpiresAt)),
      String(TERMINAL_TTL_SEC),
    ]);
    const record = parseRecord(value);
    if (record) remember(record);
    return record;
  }
  const current = jobs.get(args.identity.workId);
  if (
    !current ||
    current.attemptId !== args.identity.attemptId ||
    current.state !== "accepted" ||
    Date.parse(current.acceptedAt) <=
      now.getTime() - DEEP_TERMINAL_DEADLINE_MS
  ) {
    return null;
  }
  const record: DeepWorkRecord = {
    ...current,
    state: "running",
    startedAt: current.startedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    leaseOwner: args.owner,
    leaseExpiresAt,
    leaseExpiresAtMs: Date.parse(leaseExpiresAt),
  };
  remember(record);
  return record;
}

const FINALIZE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.attemptId ~= ARGV[1] or job.state ~= "running" or
   job.leaseOwner ~= ARGV[2] or not job.leaseExpiresAtMs or
   job.leaseExpiresAtMs <= tonumber(ARGV[7]) then return 0 end
job.state = ARGV[3]
job.updatedAt = ARGV[4]
job.finishedAt = ARGV[4]
job.reply = cjson.decode(ARGV[5])
job.leaseOwner = nil
job.leaseExpiresAt = nil
job.leaseExpiresAtMs = nil
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[6])
return 1
`;

export async function finalizeDeepWork(args: {
  identity: DeepResearchAttemptIdentity;
  owner: string;
  reply: DeepResearchReply;
}): Promise<boolean> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const state = args.reply.status === "success" ? "succeeded" : "failed";
  if (hasUpstash) {
    const updated = await (await redis()).eval(
      FINALIZE_SCRIPT,
      [key(args.identity.workId)],
      [
        args.identity.attemptId,
        args.owner,
        state,
        now,
        JSON.stringify(args.reply),
        String(TERMINAL_TTL_SEC),
        String(nowDate.getTime()),
      ]
    );
    if (Number(updated) !== 1) return false;
    const record = await readRedisRecord(args.identity.workId);
    if (record) remember(record);
    return true;
  }
  const current = jobs.get(args.identity.workId);
  if (
    !current ||
    current.attemptId !== args.identity.attemptId ||
    current.state !== "running" ||
    current.leaseOwner !== args.owner ||
    current.leaseExpiresAtMs === undefined ||
    current.leaseExpiresAtMs <= nowDate.getTime()
  ) {
    return false;
  }
  remember({
    ...current,
    state,
    updatedAt: now,
    finishedAt: now,
    reply: args.reply,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    leaseExpiresAtMs: undefined,
  });
  return true;
}

export async function failAcceptedDeepWork(args: {
  identity: DeepResearchAttemptIdentity;
  reply: DeepResearchReply;
  responseId?: string;
  expiresAt?: string;
}): Promise<void> {
  // Redis owns the record whenever configured; local memory is only a cache.
  const current = hasUpstash
    ? await readRedisRecord(args.identity.workId)
    : jobs.get(args.identity.workId) ?? null;
  const now = new Date().toISOString();
  const record: DeepWorkRecord = {
    version: 1,
    ...args.identity,
    responseId:
      current?.responseId ??
      args.responseId ??
      "00000000-0000-4000-8000-000000000000",
    state: "failed",
    acceptedAt: current?.acceptedAt ?? now,
    updatedAt: now,
    finishedAt: now,
    expiresAt:
      current?.expiresAt ??
      args.expiresAt ??
      new Date(Date.now() + TERMINAL_TTL_SEC * 1000).toISOString(),
    reply: args.reply,
  };
  if (hasUpstash) {
    const updated = await (await redis()).eval(
      `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.attemptId ~= ARGV[1] or job.state ~= "accepted" then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1
`,
      [key(record.workId)],
      [
        args.identity.attemptId,
        JSON.stringify(record),
        String(TERMINAL_TTL_SEC),
      ]
    );
    if (Number(updated) !== 1) return;
  } else if (
    current &&
    (current.attemptId !== args.identity.attemptId ||
      current.state !== "accepted")
  ) {
    return;
  }
  remember(record);
}

export async function runIdempotentDeepWork(
  workId: string,
  task: () => Promise<DeepResearchReply>
): Promise<DeepResearchReply> {
  const status = await readDeepWorkStatus(workId);
  if (status.state === "done") return status.reply;
  const running = pending.get(workId);
  if (running) return running;
  const work = (async () => {
    await markDeepWorkAccepted(workId);
    const reply = await task();
    await storeDeepWorkResult(reply);
    return reply;
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
  jobs.clear();
  testDurableStatusReader = undefined;
}

/** Injects only the authoritative status read used by focused store tests. */
export function setDeepWorkDurableStatusReaderForTests(
  reader?: (workId: string) => Promise<DeepWorkRecord | null>
): void {
  testDurableStatusReader = reader;
}

/** Compatibility helper for tests and older internal callers. */
export async function markDeepWorkAccepted(workId: string): Promise<void> {
  await acceptDeepWork({
    identity: { workId, attemptId: workId, attempt: 1 },
    responseId: "00000000-0000-4000-8000-000000000000",
    expiresAt: new Date(Date.now() + TERMINAL_TTL_SEC * 1000).toISOString(),
  });
}

export type DeepWorkStatus =
  | { state: "unknown" }
  | { state: "pending" }
  | { state: "done"; reply: DeepResearchReply };

function timeoutReply(workId: string): DeepResearchReply {
  return {
    workId,
    status: "failure",
    text: "Research deeper did not complete within its 120-second budget. The regular answer remains available; start a new pass to retry.",
    retryable: true,
  };
}

const TIMEOUT_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local job = cjson.decode(raw)
if job.state == "accepted" and job.acceptedAt <= ARGV[1] then
  job.state = "failed"
elseif job.state == "running" and
  ((job.leaseExpiresAtMs and job.leaseExpiresAtMs <= tonumber(ARGV[2])) or
   (not job.leaseExpiresAtMs and job.leaseExpiresAt and job.leaseExpiresAt <= ARGV[3]) or
   (not job.leaseExpiresAtMs and not job.leaseExpiresAt)) then
  job.state = "failed"
else
  return raw
end
job.updatedAt = ARGV[3]
job.finishedAt = ARGV[3]
job.reply = cjson.decode(ARGV[4])
job.leaseOwner = nil
job.leaseExpiresAt = nil
job.leaseExpiresAtMs = nil
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded, "EX", ARGV[5])
return encoded
`;

function timeoutInMemory(
  record: DeepWorkRecord,
  now: Date
): DeepWorkRecord {
  const acceptedExpired =
    record.state === "accepted" &&
    Date.parse(record.acceptedAt) <=
      now.getTime() - DEEP_TERMINAL_DEADLINE_MS;
  const leaseExpired =
    record.state === "running" &&
    (record.leaseExpiresAtMs !== undefined
      ? record.leaseExpiresAtMs <= now.getTime()
      : record.leaseExpiresAt === undefined ||
        Date.parse(record.leaseExpiresAt) <= now.getTime());
  if (!acceptedExpired && !leaseExpired) return record;
  const timestamp = now.toISOString();
  return {
    ...record,
    state: "failed",
    updatedAt: timestamp,
    finishedAt: timestamp,
    reply: timeoutReply(record.workId),
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    leaseExpiresAtMs: undefined,
  };
}

/**
 * Polling view of a job. It reads the same keys the worker writes, so an
 * asynchronous result and a synchronous one are indistinguishable to callers.
 */
export async function readDeepWorkStatus(
  workId: string,
  options: { now?: Date } = {}
): Promise<DeepWorkStatus> {
  const now = options.now ?? new Date();
  let record = jobs.get(workId) ?? null;
  let durableReadFailed = false;
  if (testDurableStatusReader) {
    try {
      const durable = await testDurableStatusReader(workId);
      record = durable ? timeoutInMemory(durable, now) : null;
    } catch {
      durableReadFailed = true;
    }
    if (record) remember(record);
  } else if (hasUpstash) {
    try {
      const value = await (await redis()).eval(
        TIMEOUT_SCRIPT,
        [key(workId)],
        [
          new Date(
            now.getTime() - DEEP_TERMINAL_DEADLINE_MS
          ).toISOString(),
          String(now.getTime()),
          now.toISOString(),
          JSON.stringify(timeoutReply(workId)),
          String(TERMINAL_TTL_SEC),
        ]
      );
      record = parseRecord(value);
    } catch {
      durableReadFailed = true;
    }
    if (record) remember(record);
  } else if (record) {
    record = timeoutInMemory(record, now);
    remember(record);
  }
  // Never extend pending from an unverifiable process-local copy when the
  // durable status/CAS read failed. The polling contract maps unknown to an
  // explicit retryable failure.
  if (durableReadFailed) return { state: "unknown" };
  if (record?.reply && (record.state === "succeeded" || record.state === "failed")) {
    return { state: "done", reply: record.reply };
  }
  if (record?.state === "accepted" || record?.state === "running") {
    return { state: "pending" };
  }
  return { state: "unknown" };
}

/** Compatibility helper. Queue failure now persists a terminal job instead. */
export async function clearDeepWorkAccepted(workId: string): Promise<void> {
  const record = hasUpstash
    ? await readRedisRecord(workId)
    : jobs.get(workId) ?? null;
  if (record?.state === "accepted") jobs.delete(workId);
  if (hasUpstash && record?.state === "accepted") {
    await (await redis()).del(key(workId));
  }
}

/** Compatibility helper for tests; worker code uses ownership-aware finalize. */
export async function storeDeepWorkResult(
  reply: DeepResearchReply
): Promise<void> {
  let current = hasUpstash
    ? await readRedisRecord(reply.workId)
    : jobs.get(reply.workId) ?? null;
  if (!current) {
    await markDeepWorkAccepted(reply.workId);
    current = hasUpstash
      ? await readRedisRecord(reply.workId)
      : jobs.get(reply.workId) ?? null;
  }
  if (!current) return;
  remember(current);
  const owner = randomUUID();
  const identity = {
    workId: reply.workId,
    attemptId: current.attemptId,
    attempt: current.attempt,
  };
  const claimed = await claimDeepWork({ identity, owner });
  if (claimed) await finalizeDeepWork({ identity, owner, reply });
}

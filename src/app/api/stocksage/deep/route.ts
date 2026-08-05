import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
} from "@/lib/config";
import { executeDeepResearch } from "@/lib/stocksage/deep/worker";
import {
  deepResearchAttemptIdentity,
  parseDeepResearchSnapshot,
} from "@/lib/stocksage/deep/snapshot";
import {
  claimDeepWork,
  failAcceptedDeepWork,
  finalizeDeepWork,
  readDeepWorkStatus,
} from "@/lib/stocksage/deep/store";
import { logStockSage } from "@/lib/stocksage/telemetry";
import type { DeepResearchReply } from "@/lib/stocksage/types";

export const dynamic = "force-dynamic";
// Deep work owns its own latency class and must outlive the 60s app default.
export const maxDuration = 150;
const DEEP_WORK_BUDGET_MS = 120_000;

async function verified(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const { Receiver } = await import("@upstash/qstash");
  const receiver = new Receiver({
    currentSigningKey: QSTASH_CURRENT_SIGNING_KEY ?? "",
    nextSigningKey: QSTASH_NEXT_SIGNING_KEY ?? "",
  });
  try {
    return await receiver.verify({ body, signature });
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Fail closed: an unsigned request must never be able to spend provider
  // budget, so this runs before the body is even interpreted.
  if (!QSTASH_CURRENT_SIGNING_KEY && !QSTASH_NEXT_SIGNING_KEY) {
    return NextResponse.json({ error: "unconfigured" }, { status: 503 });
  }
  const raw = await request.text();
  if (!(await verified(raw, request.headers.get("upstash-signature")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: { token?: unknown; workId?: unknown; attemptId?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const snapshot = parseDeepResearchSnapshot(payload.token);
  if (!snapshot) {
    return NextResponse.json({ error: "invalid_snapshot" }, { status: 400 });
  }
  const identity = deepResearchAttemptIdentity(snapshot);
  if (
    payload.workId !== identity.workId ||
    payload.attemptId !== identity.attemptId
  ) {
    await failAcceptedDeepWork({
      identity,
      responseId: snapshot.responseId,
      expiresAt: snapshot.expiresAt,
      reply: {
        workId: identity.workId,
        status: "failure",
        text: "Research deeper could not verify its queued attempt. The regular answer remains available.",
        retryable: true,
      },
    }).catch(() => undefined);
    return NextResponse.json({ error: "payload_mismatch" }, { status: 400 });
  }

  const owner = randomUUID();
  const claimed = await claimDeepWork({ identity, owner });
  if (!claimed) {
    const existing = await readDeepWorkStatus(identity.workId).catch(() => ({
      state: "unknown" as const,
    }));
    if (existing.state === "done") {
      return NextResponse.json({ ok: true, status: existing.reply.status });
    }
    return NextResponse.json({ error: "ownership_conflict" }, { status: 409 });
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reply: DeepResearchReply;
  try {
    reply = await Promise.race([
      executeDeepResearch(snapshot),
      new Promise<DeepResearchReply>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              workId: identity.workId,
              status: "failure",
              text: "Research deeper reached its time budget. The regular answer remains available.",
              retryable: true,
            }),
          DEEP_WORK_BUDGET_MS
        );
      }),
    ]);
  } catch {
    reply = {
      workId: identity.workId,
      status: "failure",
      text: "Research deeper could not finish. The regular answer remains available.",
      retryable: true,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const finalized = await finalizeDeepWork({ identity, owner, reply }).catch(
    () => false
  );
  logStockSage({
    event: "deep_work_complete",
    latencyClass: "deep_work",
    durationMs: Date.now() - startedAt,
    reasonCode: finalized ? reply.status : "stale_owner",
    retryVisible: reply.retryable === true,
  });
  if (!finalized) {
    // If this owner crossed its lease boundary, force the same atomic timeout
    // transition polling uses before acknowledging the handled delivery.
    const status = await readDeepWorkStatus(identity.workId).catch(() => ({
      state: "unknown" as const,
    }));
    if (status.state === "done") {
      return NextResponse.json({ ok: true, status: status.reply.status });
    }
    return NextResponse.json({ error: "stale_owner" }, { status: 409 });
  }
  // A retryable failure is terminal for this attempt. A user retry gets a new
  // signed workId/attemptId and never races a redelivery of this identity.
  return NextResponse.json({ ok: true, status: reply.status });
}

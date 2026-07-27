import { NextResponse } from "next/server";
import {
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
} from "@/lib/config";
import { runDeepResearch } from "@/lib/stocksage/deep";
import {
  clearDeepWorkAccepted,
  storeDeepWorkResult,
} from "@/lib/stocksage/deep-store";
import { logStockSage } from "@/lib/stocksage/telemetry";

export const dynamic = "force-dynamic";
// Deep work owns its own latency class and must outlive the 60s app default.
export const maxDuration = 150;

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

  let payload: { token?: unknown; workId?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const startedAt = Date.now();
  const reply = await runDeepResearch(payload.token);
  await storeDeepWorkResult(reply);
  await clearDeepWorkAccepted(reply.workId);
  logStockSage({
    event: "deep_work_complete",
    latencyClass: "deep_work",
    durationMs: Date.now() - startedAt,
    reasonCode: reply.status,
    retryVisible: reply.retryable === true,
  });
  // A retryable failure is still a handled delivery; asking QStash to redeliver
  // would race the user's own retry against the same workId.
  return NextResponse.json({ ok: true, status: reply.status });
}

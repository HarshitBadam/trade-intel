import { NextResponse } from "next/server";
import {
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
} from "@/lib/config";
import {
  markRefreshJobDone,
  markRefreshJobRunning,
} from "@/lib/market-intelligence/job-store";
import { parseTickerRefreshPayload } from "@/lib/market-intelligence/queue";
import {
  finalizeTerminalFailure,
  runTickerRefreshJob,
} from "@/lib/market-intelligence/worker";
import { recordMarketIntelligenceEvent } from "@/lib/market-intelligence/telemetry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function verifyQStash(body: string, signature: string | null) {
  if (
    !signature ||
    (!QSTASH_CURRENT_SIGNING_KEY && !QSTASH_NEXT_SIGNING_KEY)
  ) {
    return false;
  }
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
  const raw = await request.text();
  if (!(await verifyQStash(raw, request.headers.get("upstash-signature")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 489 });
  }
  const payload = parseTickerRefreshPayload(value);
  if (!payload) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 489 });
  }

  const startedAt = Date.now();
  const job = await markRefreshJobRunning(payload.workId, payload.ticker);
  if (!job) {
    recordMarketIntelligenceEvent("worker_ignored", {
      ticker: payload.ticker,
      reason: "unknown_job",
    });
    return NextResponse.json({ ok: true, state: "ignored_unknown" });
  }
  if (job.state === "done" || job.state === "failed") {
    recordMarketIntelligenceEvent("worker_ignored", {
      ticker: payload.ticker,
      reason: `terminal_${job.state}`,
    });
    return NextResponse.json({ ok: true, state: job.state });
  }
  try {
    const result: unknown = await runTickerRefreshJob(payload);
    const outcome =
      result && typeof result === "object"
        ? (result as {
            ok?: boolean;
            retryable?: boolean;
            error?: string;
            errorCode?: string;
            retryAfter?: string;
          })
        : undefined;

    if (outcome?.ok === false && outcome.retryable === true) {
      recordMarketIntelligenceEvent("worker_retryable_failure", {
        ticker: payload.ticker,
        errorCode: outcome.errorCode ?? "refresh_retryable",
        durationMs: Date.now() - startedAt,
      });
      // Preserve typed provider/model retry timing when available so QStash
      // (and any direct caller) can honor an honest Retry-After instead of
      // always falling back to its own default backoff.
      const retryAfterMs = outcome.retryAfter
        ? Date.parse(outcome.retryAfter) - Date.now()
        : undefined;
      const retryAfterSec =
        typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
          ? Math.max(1, Math.ceil(retryAfterMs / 1000))
          : undefined;
      return NextResponse.json(
        { ok: false, error: outcome.errorCode ?? "refresh_retryable" },
        {
          status: 503,
          ...(retryAfterSec
            ? { headers: { "Retry-After": String(retryAfterSec) } }
            : {}),
        }
      );
    }
    if (outcome?.ok === false) {
      const errorCode = outcome.errorCode ?? outcome.error ?? "refresh_failed";
      const retryAfter =
        outcome.retryAfter ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { claimed } = await finalizeTerminalFailure(
        payload,
        errorCode,
        retryAfter
      ).catch(() => ({ claimed: false }));
      recordMarketIntelligenceEvent("worker_terminal_failure", {
        ticker: payload.ticker,
        errorCode,
        durationMs: Date.now() - startedAt,
        claimed,
      });
      return NextResponse.json({ ok: true, state: "failed" });
    }

    await markRefreshJobDone(payload.workId, payload.ticker);
    recordMarketIntelligenceEvent("worker_complete", {
      ticker: payload.ticker,
      outcome:
        result && typeof result === "object" && "outcome" in result
          ? String((result as { outcome: unknown }).outcome)
          : "done",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true, state: "done" });
  } catch {
    // Any thrown failure is retryable. QStash must see a non-2xx response so
    // its configured attempts and eventual failure callback remain effective.
    recordMarketIntelligenceEvent("worker_exception", {
      ticker: payload.ticker,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      { ok: false, error: "refresh_retryable" },
      { status: 500 }
    );
  }
}

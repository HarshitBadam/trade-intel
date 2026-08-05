import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import {
  QSTASH_CURRENT_SIGNING_KEY,
  QSTASH_NEXT_SIGNING_KEY,
} from "@/lib/config";
import { parseTickerRefreshPayload } from "@/lib/market-intelligence/queue";
import { finalizeTerminalFailure } from "@/lib/market-intelligence/worker";

export const dynamic = "force-dynamic";

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

function originalPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const callback = value as {
    sourceBody?: unknown;
    body?: unknown;
  };
  if (typeof callback.sourceBody === "string") {
    try {
      return JSON.parse(Buffer.from(callback.sourceBody, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  // Keeping this narrow fallback makes local QStash-compatible emulators and
  // focused route tests useful without accepting arbitrary callback shapes.
  return callback.body;
}

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();
  if (!(await verifyQStash(raw, request.headers.get("upstash-signature")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let callback: unknown;
  try {
    callback = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 489 });
  }
  const payload = parseTickerRefreshPayload(originalPayload(callback));
  if (!payload) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 489 });
  }

  const responseStatus =
    callback &&
    typeof callback === "object" &&
    typeof (callback as { status?: unknown }).status === "number"
      ? (callback as { status: number }).status
      : undefined;
  const errorCode = responseStatus
    ? `qstash_delivery_exhausted:${responseStatus}`
    : "qstash_delivery_exhausted";
  const retryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  // Coordinated with the direct worker response: whichever of the two calls
  // (this callback, or a direct nonretryable worker response) observes the
  // job first wins the atomic finalization claim. The loser no-ops instead
  // of re-running fallback publication over a job that is already terminal.
  await finalizeTerminalFailure(payload, errorCode, retryAfter).catch(
    (error) => {
      console.error("[market-intelligence] terminal fallback failed:", error);
      return { claimed: false };
    }
  );
  return NextResponse.json({ ok: true });
}

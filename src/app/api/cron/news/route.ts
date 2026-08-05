import { NextResponse } from "next/server";

/**
 * Retained briefly so an unreconciled legacy schedule fails safely without
 * running universe-wide provider work.
 */
export async function GET(_request: Request): Promise<NextResponse> {
  return NextResponse.json(
    { ok: false, error: "retired", replacement: "/api/cron/showcase" },
    { status: 410 }
  );
}

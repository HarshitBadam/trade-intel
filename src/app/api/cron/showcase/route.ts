import { NextResponse } from "next/server";
import {
  enqueueShowcaseRefreshes,
  isShowcaseScheduleHealthy,
} from "@/lib/market-intelligence/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request): Promise<NextResponse> {
  if (
    !CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const report = await enqueueShowcaseRefreshes();
  // "ok" is only true when every selected ticker reached known active work
  // (freshly queued or joined to an already-active job). Uncertain publish
  // outcomes, suppressed cooldown/budget denials, and thrown failures are
  // all honest, expected terminal states individually, but none of them
  // guarantee the ticker is actively progressing — so they must make the
  // run unhealthy rather than being papered over as ok. Per-state counts
  // and results are always preserved for operational visibility.
  const ok = isShowcaseScheduleHealthy(report);

  return NextResponse.json({
    ok,
    ...report,
  });
}

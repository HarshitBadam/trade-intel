import { NextResponse } from "next/server";
import { pruneOldArticles } from "@/lib/market-data/news/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request): Promise<NextResponse> {
  if (
    !CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pruned = await pruneOldArticles(90).catch((error) => {
    console.error("[maintenance] article pruning failed:", error);
    return null;
  });
  return NextResponse.json({ ok: pruned !== null, pruned });
}

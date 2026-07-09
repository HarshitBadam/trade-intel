import "server-only";

import { after } from "next/server";
import { revalidateTag } from "next/cache";
import { hasGroq } from "@/lib/config";
import { guard } from "@/lib/guard";
import { requestPriorityAnalysis } from "@/lib/market-data";

// The interactive cold-ticker trigger (redesign §8, D23). Lives in the
// ACTION/PAGE layer on purpose: after() and revalidateTag are Next-only runtime
// APIs, and revalidateTag must NOT sit in a src/lib module (the tsx ops scripts
// import those libs outside a Next request context).
//
// requestPriorityAnalysis already self-guards with a single-flight claim and a
// zero-stored gate, so this only adds PER-USER protection: one user can't spam
// cold tickers into Groq burns. On guard denial we simply skip the trigger — the
// page still renders the Alpaca headlines it already fetched.
//
// Returns true when a run was actually dispatched, so getDetailsData can honestly
// report "analyzing" (vs "unavailable") for a cold ticker with no Alpaca news.
// The heavy work (Polygon load + one Groq pass) runs in after(), off the
// response's critical path; on a successful run we revalidateTag("news") so the
// client's slim poll sees the fresh verdict.
export async function triggerPriorityAnalysis(ticker: string): Promise<boolean> {
  if (!hasGroq) return false;

  const access = await guard("priority-analysis", { limit: 4, windowSec: 60 });
  if (!access.ok) return false;

  after(async () => {
    const result = await requestPriorityAnalysis(ticker);
    if (result.status === "started") revalidateTag("news");
  });
  return true;
}

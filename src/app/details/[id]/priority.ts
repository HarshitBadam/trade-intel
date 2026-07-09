import "server-only";

import { after } from "next/server";
import { revalidateTag } from "next/cache";
import { hasGroq } from "@/lib/config";
import { guard } from "@/lib/guard";
import { requestPriorityAnalysis } from "@/lib/market-data";

// Lives in the page layer: after() and revalidateTag are Next-only runtime APIs
// that must NOT sit in src/lib (ops scripts import those modules outside a Next
// request context). requestPriorityAnalysis self-guards with a single-flight
// claim; this adds per-user rate limiting on top. Returns true when a run was
// dispatched so callers can report "analyzing" for cold tickers.
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

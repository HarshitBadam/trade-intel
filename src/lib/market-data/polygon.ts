import "server-only";

import { POLYGON_API_KEY } from "@/lib/config";

// The Response is returned as-is (ok or not) on purpose: callers keep their own
// status handling — a 404 on ticker-detail means "no reference entry" (cache null),
// the grouped-daily walk-back distinguishes an empty OK day from an error, etc.
export async function polygonFetch(url: string): Promise<Response> {
  return fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
  });
}

// Used by callers that walk back multiple days (grouped-daily, year-ago): must only
// advance on a genuinely empty OK response. A transient error (429/403/5xx) would
// fail for every prior day too — continuing would just burn extra requests.
// Throwing also keeps unstable_cache from pinning the failure for the revalidate window.
export function assertPolygonOk(response: Response, what: string): void {
  if (response.ok) return;
  console.error(
    `[polygon] ${what} fetch failed: ${response.status} ${response.statusText}`
  );
  throw new Error(`polygon ${what} failed: ${response.status}`);
}

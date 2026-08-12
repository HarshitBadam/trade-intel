import "server-only";

import { slidingLimiter } from "./limiter";
import type { SecEdgarDependencies } from "./sec-edgar-types";

const SEC_TIMEOUT_MS = 10_000;

/** SEC requires automated clients to identify an organization and contact. */
export const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ??
  "TradeIntel StockSage research service support@tradeintel.app";

const acquireSecSlot = slidingLimiter(8, 1_000);

export async function fetchSecJson(
  url: string,
  dependencies: SecEdgarDependencies
): Promise<unknown> {
  await (dependencies.acquire ?? acquireSecSlot)();
  const response = await (dependencies.fetch ?? fetch)(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": dependencies.userAgent ?? SEC_USER_AGENT,
    },
    signal: AbortSignal.timeout(SEC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SEC EDGAR responded with ${response.status}`);
  return response.json();
}

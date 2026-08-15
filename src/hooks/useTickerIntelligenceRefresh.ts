"use client";

import { useEffect, useState } from "react";
import {
  fetchDetails,
  pollDetailsRefresh,
  requestDetailsRefresh,
} from "@/app/details/[id]/actions";
import {
  computeRetryAfterSec,
  deriveActiveRefreshState,
  POLL_DELAYS_MS,
  shouldApplyRefreshedGeneration,
  shouldRequestDetailsRefresh,
  type StockData,
} from "@/lib/market-intelligence/types";

/**
 * Drives the details page's bounded intelligence-refresh lifecycle: when
 * `initial` is stale/missing/degraded, requests a refresh job and polls it
 * with backoff (`POLL_DELAYS_MS`) until it completes, fails, or the
 * polling window is exhausted (leaving the job "backgrounded" rather than
 * implying nothing is happening). A failed request or poll is retried
 * after the server's `retryAfterSec` cooldown. All timers and the
 * in-flight chain are cancelled on unmount or when `initial`/`ticker`
 * change.
 */
export function useTickerIntelligenceRefresh(
  initial: StockData,
  ticker: string
): StockData {
  const [stockData, setStockData] = useState<StockData>(initial);

  useEffect(() => {
    if (!shouldRequestDetailsRefresh(initial.newsStatus, initial.intelligence.state)) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = POLL_DELAYS_MS;

    const run = async () => {
      const requested = await requestDetailsRefresh(ticker);
      if (cancelled) return;
      if (!requested.ok) {
        setStockData((current) => ({
          ...current,
          intelligence: {
            ...current.intelligence,
            refreshState: "failed",
            retryAfterSec: requested.retryAfterSec,
          },
        }));
        if (requested.retryAfterSec) {
          timer = setTimeout(
            () => void run(),
            Math.max(1, requested.retryAfterSec) * 1000
          );
        }
        return;
      }
      const { workId } = requested.job;
      if (requested.job.state === "failed") {
        setStockData((current) => ({
          ...current,
          intelligence: {
            ...current.intelligence,
            refreshState: "failed",
            retryAfterSec: computeRetryAfterSec(requested.job.retryAfter),
          },
        }));
        const retryAfterSec = computeRetryAfterSec(requested.job.retryAfter);
        if (retryAfterSec) {
          timer = setTimeout(() => void run(), retryAfterSec * 1000);
        }
        return;
      }
      setStockData((current) => ({
        ...current,
        intelligence: {
          ...current.intelligence,
          refreshState: deriveActiveRefreshState(requested.job.state),
          retryAfterSec: undefined,
        },
      }));

      const poll = async (attempt: number): Promise<void> => {
        if (cancelled) return;
        if (attempt >= delays.length) {
          // Active polling stops here (~2 minutes), but the durable job on
          // the server may still be queued/running. "backgrounded" is an
          // honest terminal state: never collapse known outstanding work
          // into "idle".
          setStockData((current) => ({
            ...current,
            intelligence: {
              ...current.intelligence,
              refreshState: "backgrounded",
            },
          }));
          return;
        }
        timer = setTimeout(async () => {
          const job = await pollDetailsRefresh(workId).catch(() => null);
          if (cancelled) return;
          if (job?.state === "done") {
            const refreshed = await fetchDetails(ticker).catch(() => null);
            if (!refreshed || cancelled) return;
            setStockData((current) =>
              shouldApplyRefreshedGeneration(
                current.intelligence.generation,
                refreshed.intelligence.generation
              )
                ? refreshed
                : current
            );
            return;
          }
          if (job?.state === "failed") {
            setStockData((current) => ({
              ...current,
              newsStatus:
                current.news.length > 0 ? "degraded" : current.newsStatus,
              intelligence: {
                ...current.intelligence,
                refreshState: "failed",
                retryAfterSec: computeRetryAfterSec(job.retryAfter),
              },
            }));
            return;
          }
          setStockData((current) => ({
            ...current,
            intelligence: {
              ...current.intelligence,
              refreshState: deriveActiveRefreshState(job?.state),
              retryAfterSec: undefined,
            },
          }));
          await poll(attempt + 1);
        }, delays[attempt]);
      };
      await poll(0);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [initial, ticker]);

  return stockData;
}

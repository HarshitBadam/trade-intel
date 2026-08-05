import "server-only";

import { requestTickerRefresh } from "./queue";
import { SHOWCASE_SYMBOLS } from "./showcase";
import { recordMarketIntelligenceEvent } from "./telemetry";

export const SHOWCASE_STAGGER_SECONDS = 60;

/**
 * Per-ticker outcome of a showcase enqueue attempt.
 *
 * - "queued": a fresh reservation was accepted and handed off to the queue.
 * - "joined": an already-active job (queued/running) absorbed this request.
 * - "uncertain": the reservation may or may not have reached the queue (the
 *   publish call threw after the job store update); the durable job still
 *   exists and may complete, but we can't confirm delivery here.
 * - "suppressed": the ticker is cooling down (recent failure) or the
 *   on-demand budget was exhausted, so nothing was published.
 * - "failed": the enqueue attempt itself threw (e.g. reservation/store
 *   error) and no durable job is guaranteed to exist.
 */
export type ShowcaseScheduleState =
  | "queued"
  | "joined"
  | "uncertain"
  | "suppressed"
  | "failed";

export type ShowcaseScheduleResult = {
  ticker: string;
  state: ShowcaseScheduleState;
  workId?: string;
};

export type ShowcaseScheduleReport = {
  selected: number;
  queued: number;
  joined: number;
  uncertain: number;
  suppressed: number;
  failed: number;
  results: ShowcaseScheduleResult[];
};

export async function enqueueShowcaseRefreshes(): Promise<ShowcaseScheduleReport> {
  const results = await Promise.all(
    SHOWCASE_SYMBOLS.map(async (ticker, index): Promise<ShowcaseScheduleResult> => {
      try {
        const job = await requestTickerRefresh(
          ticker,
          "showcase_cron",
          index * SHOWCASE_STAGGER_SECONDS
        );
        if (job.publish === "suppressed") {
          return { ticker, state: "suppressed", workId: job.workId };
        }
        if (job.publish === "uncertain") {
          return { ticker, state: "uncertain", workId: job.workId };
        }
        return {
          ticker,
          state: job.joined ? "joined" : "queued",
          workId: job.workId,
        };
      } catch {
        return { ticker, state: "failed" };
      }
    })
  );
  const count = (state: ShowcaseScheduleState) =>
    results.filter((result) => result.state === state).length;
  const report: ShowcaseScheduleReport = {
    selected: SHOWCASE_SYMBOLS.length,
    queued: count("queued"),
    joined: count("joined"),
    uncertain: count("uncertain"),
    suppressed: count("suppressed"),
    failed: count("failed"),
    results,
  };
  recordMarketIntelligenceEvent("showcase_schedule", {
    selected: report.selected,
    queued: report.queued,
    joined: report.joined,
    uncertain: report.uncertain,
    suppressed: report.suppressed,
    failed: report.failed,
  });
  return report;
}

/**
 * A showcase run is operationally healthy only when every selected ticker
 * landed in a *known active* handoff: freshly "queued" or "joined" to
 * already-active work. "uncertain" (publish confirmation lost),
 * "suppressed" (cooldown/budget), and "failed" (thrown) are all honest but
 * non-healthy outcomes — none of them guarantee the ticker is actively
 * progressing toward a refresh, so they must not be papered over as ok.
 */
export function isShowcaseScheduleHealthy(
  report: ShowcaseScheduleReport
): boolean {
  return report.queued + report.joined === report.selected;
}

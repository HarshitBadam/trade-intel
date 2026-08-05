/**
 * Pure polling/backoff helpers for Deep Research status checks. Kept free of
 * React and network calls so the schedule and stopping rules are directly
 * testable; `FloatingWidget.tsx` is the only caller that actually sleeps and
 * fetches.
 */

/** Bounded backoff schedule: 2s, 4s, 8s, 15s, then holds at 30s. */
export const DEEP_POLL_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;

/**
 * Total wall-clock budget the widget spends actively polling before it gives
 * up watching and surfaces a backgrounded/timeout state. Matches the
 * architecture's 120-second Deep Research work budget so the widget never
 * claims failure before the job itself could have reached a terminal state.
 */
export const DEEP_POLL_BUDGET_MS = 120_000;

/** Delay before the (0-indexed) `attempt`th poll. Holds at the final step. */
export function deepPollDelayMs(
  attempt: number,
  schedule: readonly number[] = DEEP_POLL_BACKOFF_MS
): number {
  const index = Math.min(Math.max(attempt, 0), schedule.length - 1);
  return schedule[index];
}

export type DeepJobStatus = "pending" | "success" | "failure";

/** A job is terminal once it is no longer pending; success and failure both stop polling. */
export function isTerminalDeepJobStatus(status: DeepJobStatus): boolean {
  return status !== "pending";
}

/** True once cumulative waited time has reached the polling budget. */
export function hasExceededDeepPollBudget(
  waitedMs: number,
  budgetMs: number = DEEP_POLL_BUDGET_MS
): boolean {
  return waitedMs >= budgetMs;
}

/** The transient-vs-terminal metadata a Deep Research reply can carry. */
export type DeepPollErrorCode = "unauthorized" | "rate_limited" | undefined;

export type DeepPollDecision =
  /** Job is still running; poll again on the normal backoff schedule. */
  | { action: "continue" }
  /** A transient admission/rate-limit denial; retry the same work after `delayMs`. */
  | { action: "retry"; delayMs: number }
  /** A terminal success, a real job failure, unauthorized, or budget exhausted. */
  | { action: "stop" };

/**
 * The one place that decides what the widget does next with a Deep Research
 * poll result. Kept pure so every branch — continue polling, retry the same
 * work after a rate limit, or stop for a real success/failure/unauthorized —
 * is directly testable without timers, network, or React.
 *
 * `unauthorized` and every failure without `errorCode: "rate_limited"`
 * (including a plain terminal job failure) resolve to `stop`: only a
 * transient admission/rate-limit denial is worth retrying automatically.
 */
export function nextDeepPollAction(args: {
  status: DeepJobStatus;
  errorCode?: DeepPollErrorCode;
  retryAfterMs?: number;
  waitedMs: number;
  attempt: number;
  budgetMs?: number;
}): DeepPollDecision {
  if (hasExceededDeepPollBudget(args.waitedMs, args.budgetMs)) {
    return { action: "stop" };
  }
  if (args.status === "pending") return { action: "continue" };
  if (args.status === "failure" && args.errorCode === "rate_limited") {
    return {
      action: "retry",
      delayMs: args.retryAfterMs ?? deepPollDelayMs(args.attempt),
    };
  }
  return { action: "stop" };
}

/**
 * A `setTimeout` that resolves early when `signal` aborts, instead of
 * leaving the widget's poll loop stuck sleeping through an unmount or a
 * superseded request. Resolves (never rejects) either way, since a delay
 * is never itself an error condition.
 */
export function cancellableDelay(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

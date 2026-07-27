import type { LatencyClass } from "./telemetry";

export const LATENCY_BUDGET_MS: Record<LatencyClass, number> = {
  instant: 500,
  regular: 5_000,
  deep_enqueue: 300,
  deep_work: 120_000,
};

/**
 * Regular turns must leave room to render a grounded answer after retrieval,
 * so retrieval gets a hard ceiling well inside the 5s end-to-end budget and
 * synthesis only runs when at least one useful attempt still fits.
 */
export const REGULAR_RETRIEVAL_CEILING_MS = 2_200;
export const SYNTHESIS_MIN_ATTEMPT_MS = 900;
/** Rendering, validation and serialization after the model returns. */
export const PUBLICATION_RESERVE_MS = 350;

export type RequestBudget = {
  readonly latencyClass: LatencyClass;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly totalMs: number;
  elapsedMs(): number;
  remainingMs(): number;
  expired(): boolean;
  /** Remaining time minus the reserve needed to publish, never negative. */
  publishableMs(): number;
  /** The smaller of a requested slice and what the top-level deadline allows. */
  slice(requestedMs: number): number;
};

export function createRequestBudget(args: {
  latencyClass: LatencyClass;
  startedAt?: number;
  totalMs?: number;
}): RequestBudget {
  const startedAt = args.startedAt ?? Date.now();
  const totalMs = args.totalMs ?? LATENCY_BUDGET_MS[args.latencyClass];
  const deadlineAt = startedAt + totalMs;
  const remaining = () => deadlineAt - Date.now();
  return {
    latencyClass: args.latencyClass,
    startedAt,
    deadlineAt,
    totalMs,
    elapsedMs: () => Date.now() - startedAt,
    remainingMs: () => Math.max(0, remaining()),
    expired: () => remaining() <= 0,
    publishableMs: () => Math.max(0, remaining() - PUBLICATION_RESERVE_MS),
    slice: (requestedMs) => Math.max(0, Math.min(requestedMs, remaining())),
  };
}

export function budgetFor(latencyClass: LatencyClass, startedAt?: number) {
  return createRequestBudget({ latencyClass, startedAt });
}

/**
 * Resolves to the fallback at the deadline and never waits for the original
 * promise afterwards, so an abandoned provider cannot delay publication.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  if (timeoutMs <= 0) {
    void promise.catch(() => undefined);
    return fallback;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function withBudget<T>(
  promise: Promise<T>,
  budget: RequestBudget,
  fallback: T,
  ceilingMs?: number
): Promise<T> {
  const allowed =
    ceilingMs === undefined
      ? budget.publishableMs()
      : Math.min(ceilingMs, budget.publishableMs());
  return withDeadline(promise, allowed, fallback);
}

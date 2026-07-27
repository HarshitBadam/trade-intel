export type LatencyClass = "instant" | "regular" | "deep_enqueue" | "deep_work";

export type RouteClass =
  | "instant_safety"
  | "instant_refusal"
  | "instant_social"
  | "instant_clarify"
  | "retrieval"
  | "deep";

export type ProviderCalls = Record<string, number>;

export type StockSageEvent = {
  event: string;
  route?: string;
  routeClass?: RouteClass;
  latencyClass?: LatencyClass;
  decisionKind?: string;
  reasonCode?: string;
  durationMs?: number;
  guardMs?: number;
  decisionMs?: number;
  planningMs?: number;
  retrievalMs?: number;
  synthesisMs?: number;
  providerCount?: number;
  providerCalls?: ProviderCalls;
  sourceCount?: number;
  dataStatus?: string;
  entities?: string[];
  budgetMs?: number;
  remainingMs?: number;
  budgetExceeded?: boolean;
  deadlineHit?: boolean;
  publicationFailure?: boolean;
  retryVisible?: boolean;
  deepEligible?: boolean;
  shadowMatch?: boolean;
  shadowField?: string;
  detail?: string;
};

type Listener = (event: StockSageEvent) => void;

const listeners = new Set<Listener>();

/**
 * Subscribing keeps the benchmark and the phase-parity tests reading the same
 * events the server logs, instead of re-deriving timings from the outside.
 */
export function onStockSageEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const quiet = process.env.STOCKSAGE_TELEMETRY === "quiet";

export function logStockSage(event: StockSageEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A telemetry consumer must never break the request it is observing.
    }
  }
  if (!quiet) console.info(`[stocksage] ${JSON.stringify(event)}`);
}

export type PhaseTimer = {
  /** Marks the start of a phase and returns the function that closes it. */
  start: (phase: "decision" | "planning" | "retrieval" | "synthesis") => () => void;
  provider: (name: string, count?: number) => void;
  timings: () => {
    decisionMs?: number;
    planningMs?: number;
    retrievalMs?: number;
    synthesisMs?: number;
    providerCalls: ProviderCalls;
    providerCount: number;
  };
};

export function createPhaseTimer(): PhaseTimer {
  const totals: Record<string, number> = {};
  const providerCalls: ProviderCalls = {};
  return {
    start(phase) {
      const startedAt = Date.now();
      return () => {
        totals[phase] = (totals[phase] ?? 0) + (Date.now() - startedAt);
      };
    },
    provider(name, count = 1) {
      providerCalls[name] = (providerCalls[name] ?? 0) + count;
    },
    timings() {
      return {
        decisionMs: totals.decision,
        planningMs: totals.planning,
        retrievalMs: totals.retrieval,
        synthesisMs: totals.synthesis,
        providerCalls,
        providerCount: Object.values(providerCalls).reduce(
          (sum, value) => sum + value,
          0
        ),
      };
    },
  };
}

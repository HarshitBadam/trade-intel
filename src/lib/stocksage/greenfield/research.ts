/**
 * Greenfield research contracts are intentionally structural. Callers can
 * adapt any retrieval provider or KV client without importing the existing
 * StockSage implementation.
 */
export type EvidenceFactValue = string | number | boolean | null;

export interface EvidenceFact {
  value: EvidenceFactValue;
  unit?: string;
  currency?: string;
  instrument?: string;
  periodStart?: string;
  periodEnd?: string;
  asOf?: string;
  availableAt?: string;
}

export interface ResearchEvidence {
  id: string;
  sourceId: string;
  sourceUrl?: string;
  title?: string;
  excerpt?: string;
  retrievedAt: string;
  observedAt?: string;
  availableAt?: string;
  /** Canonical issuer/entity identity, independent of any traded listing. */
  subjectId?: string;
  /** All canonical subjects when one document covers more than one entity. */
  subjectIds?: readonly string[];
  /** Canonical security-master identity when one is known. */
  instrumentId?: string;
  /** Provider-native symbol used to retrieve this evidence. */
  providerSymbol?: string;
  /** Equivalent provider/venue spellings such as MQG, MQG.AX, and ASX:MQG. */
  instrumentAliases?: readonly string[];
  /**
   * `exact_period` participates in market-session alignment. Document
   * `freshness` and stable `timeless` evidence retain availability checks but
   * are not forced into an exact trading-session window.
   */
  temporalSemantics?: "exact_period" | "freshness" | "timeless";
  /** Legacy provider symbol retained for existing composers and consumers. */
  instrument?: string;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  facts?: Readonly<Record<string, EvidenceFact>>;
  /** Stable proposition keys this item directly supports. */
  supports?: readonly string[];
  quality?: number;
  laneId?: string;
}

export type ResearchDepth = "glance" | "standard" | "detailed" | "deep";

export interface EvidenceLane {
  id: string;
  kind: string;
  query: string;
  priority?: number;
  estimatedCost?: number;
  maxItems?: number;
}

export interface ResearchLimits {
  maxSteps: number;
  maxTimeMs: number;
  maxCost: number;
  maxParallel: number;
}

export interface EvidenceSufficiencyPolicy {
  minEvidence: number;
  minIndependentSources: number;
  minCompletedLanes: number;
  minQualityScore?: number;
}

export interface ResearchPlan {
  version: 1;
  id: string;
  question: string;
  depth: ResearchDepth;
  asOf: string;
  lanes: readonly EvidenceLane[];
  limits: ResearchLimits;
  sufficiency: EvidenceSufficiencyPolicy;
}

export interface ResearchPlanInput {
  id: string;
  question: string;
  depth?: ResearchDepth;
  asOf?: string;
  lanes: readonly EvidenceLane[];
  limits?: Partial<ResearchLimits>;
  sufficiency?: Partial<EvidenceSufficiencyPolicy>;
}

const DEPTH_DEFAULTS: Record<
  ResearchDepth,
  { limits: ResearchLimits; sufficiency: EvidenceSufficiencyPolicy }
> = {
  glance: {
    limits: { maxSteps: 1, maxTimeMs: 1_000, maxCost: 1, maxParallel: 1 },
    sufficiency: {
      minEvidence: 1,
      minIndependentSources: 1,
      minCompletedLanes: 1,
    },
  },
  standard: {
    limits: { maxSteps: 4, maxTimeMs: 5_000, maxCost: 4, maxParallel: 2 },
    sufficiency: {
      minEvidence: 2,
      minIndependentSources: 2,
      minCompletedLanes: 1,
    },
  },
  detailed: {
    limits: { maxSteps: 8, maxTimeMs: 20_000, maxCost: 10, maxParallel: 3 },
    sufficiency: {
      minEvidence: 4,
      minIndependentSources: 3,
      minCompletedLanes: 2,
    },
  },
  deep: {
    limits: { maxSteps: 16, maxTimeMs: 120_000, maxCost: 30, maxParallel: 4 },
    sufficiency: {
      minEvidence: 8,
      minIndependentSources: 4,
      minCompletedLanes: 3,
    },
  },
};

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function uniqueLanes(lanes: readonly EvidenceLane[]): EvidenceLane[] {
  const seen = new Set<string>();
  return lanes
    .filter((lane) => {
      if (!lane.id || seen.has(lane.id)) return false;
      seen.add(lane.id);
      return true;
    })
    .map((lane) => ({
      ...lane,
      estimatedCost: nonNegative(lane.estimatedCost ?? 1, 1),
      maxItems:
        lane.maxItems === undefined
          ? undefined
          : positiveInteger(lane.maxItems, 1),
    }))
    .sort(
      (left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) ||
        left.id.localeCompare(right.id)
    );
}

/**
 * Produces a serializable, bounded plan. Executable provider functions are
 * injected into the orchestrator and therefore never enter durable state.
 */
export function createResearchPlan(input: ResearchPlanInput): ResearchPlan {
  const depth = input.depth ?? "standard";
  const defaults = DEPTH_DEFAULTS[depth];
  const maxSteps = positiveInteger(
    input.limits?.maxSteps ?? defaults.limits.maxSteps,
    defaults.limits.maxSteps
  );
  const maxParallel = Math.min(
    maxSteps,
    positiveInteger(
      input.limits?.maxParallel ?? defaults.limits.maxParallel,
      defaults.limits.maxParallel
    )
  );
  const limits: ResearchLimits = {
    maxSteps,
    maxParallel,
    maxTimeMs: positiveInteger(
      input.limits?.maxTimeMs ?? defaults.limits.maxTimeMs,
      defaults.limits.maxTimeMs
    ),
    maxCost: nonNegative(
      input.limits?.maxCost ?? defaults.limits.maxCost,
      defaults.limits.maxCost
    ),
  };
  const minQualityScore =
    input.sufficiency?.minQualityScore ??
    defaults.sufficiency.minQualityScore;
  const sufficiency: EvidenceSufficiencyPolicy = {
    minEvidence: positiveInteger(
      input.sufficiency?.minEvidence ??
        defaults.sufficiency.minEvidence,
      defaults.sufficiency.minEvidence
    ),
    minIndependentSources: positiveInteger(
      input.sufficiency?.minIndependentSources ??
        defaults.sufficiency.minIndependentSources,
      defaults.sufficiency.minIndependentSources
    ),
    minCompletedLanes: positiveInteger(
      input.sufficiency?.minCompletedLanes ??
        defaults.sufficiency.minCompletedLanes,
      defaults.sufficiency.minCompletedLanes
    ),
    ...(minQualityScore === undefined ? {} : { minQualityScore }),
  };
  return {
    version: 1,
    id: input.id,
    question: input.question,
    depth,
    asOf: input.asOf ?? new Date().toISOString(),
    lanes: uniqueLanes(input.lanes).slice(0, maxSteps),
    limits,
    sufficiency,
  };
}

export interface EvidenceSufficiency {
  sufficient: boolean;
  evidenceCount: number;
  independentSourceCount: number;
  completedLaneCount: number;
  qualityScore: number;
  missing: string[];
}

export function evaluateEvidenceSufficiency(args: {
  evidence: readonly ResearchEvidence[];
  completedLaneIds: ReadonlySet<string> | readonly string[];
  policy: EvidenceSufficiencyPolicy;
}): EvidenceSufficiency {
  const completed =
    args.completedLaneIds instanceof Set
      ? args.completedLaneIds
      : new Set(args.completedLaneIds);
  const sourceCount = new Set(args.evidence.map((item) => item.sourceId)).size;
  const qualityScore = args.evidence.reduce(
    (sum, item) => sum + Math.max(0, Math.min(1, item.quality ?? 0.5)),
    0
  );
  const missing: string[] = [];
  if (args.evidence.length < args.policy.minEvidence) {
    missing.push("evidence");
  }
  if (sourceCount < args.policy.minIndependentSources) {
    missing.push("independent_sources");
  }
  if (completed.size < args.policy.minCompletedLanes) {
    missing.push("completed_lanes");
  }
  if (
    args.policy.minQualityScore !== undefined &&
    qualityScore < args.policy.minQualityScore
  ) {
    missing.push("quality");
  }
  return {
    sufficient: missing.length === 0,
    evidenceCount: args.evidence.length,
    independentSourceCount: sourceCount,
    completedLaneCount: completed.size,
    qualityScore,
    missing,
  };
}

export type ResearchProgressEvent =
  | {
      type: "accepted" | "started";
      runId: string;
      at: string;
    }
  | {
      type: "lane_started";
      runId: string;
      at: string;
      laneId: string;
      step: number;
    }
  | {
      type: "lane_completed";
      runId: string;
      at: string;
      laneId: string;
      step: number;
      evidenceCount: number;
      cost: number;
    }
  | {
      type: "lane_failed";
      runId: string;
      at: string;
      laneId: string;
      step: number;
      error: string;
    }
  | {
      type: "sufficiency_checked";
      runId: string;
      at: string;
      result: EvidenceSufficiency;
    }
  | {
      type: "budget_exhausted";
      runId: string;
      at: string;
      budget: "steps" | "time" | "cost";
    }
  | {
      type: "cancelled";
      runId: string;
      at: string;
      reason?: string;
    }
  | {
      type: "completed";
      runId: string;
      at: string;
      sufficient: boolean;
    };

export type ResearchRunState =
  | "accepted"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface ResearchRunRecord {
  version: 1;
  runId: string;
  plan: ResearchPlan;
  state: ResearchRunState;
  acceptedAt: string;
  updatedAt: string;
  finishedAt?: string;
  stepsUsed: number;
  costUsed: number;
  completedLaneIds: string[];
  evidence: ResearchEvidence[];
  progress: ResearchProgressEvent[];
  sufficiency?: EvidenceSufficiency;
  error?: string;
}

export interface ResearchPersistence {
  create(record: ResearchRunRecord): Promise<boolean>;
  save(record: ResearchRunRecord): Promise<void>;
  load(runId: string): Promise<ResearchRunRecord | null>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryResearchPersistence implements ResearchPersistence {
  private readonly records = new Map<string, ResearchRunRecord>();

  async create(record: ResearchRunRecord): Promise<boolean> {
    if (this.records.has(record.runId)) return false;
    this.records.set(record.runId, clone(record));
    return true;
  }

  async save(record: ResearchRunRecord): Promise<void> {
    this.records.set(record.runId, clone(record));
  }

  async load(runId: string): Promise<ResearchRunRecord | null> {
    const record = this.records.get(runId);
    return record ? clone(record) : null;
  }
}

/**
 * Minimal shape implemented by @upstash/redis and compatible test doubles.
 * Configuration and client construction stay with the caller.
 */
export interface InjectedKeyValue {
  get<T = unknown>(key: string): Promise<T | string | null>;
  set(
    key: string,
    value: unknown,
    options?: { nx?: boolean; ex?: number }
  ): Promise<unknown>;
}

export interface UpstashResearchPersistenceOptions {
  prefix?: string;
  ttlSeconds?: number;
}

export class UpstashResearchPersistence implements ResearchPersistence {
  private readonly prefix: string;
  private readonly ttlSeconds?: number;

  constructor(
    private readonly kv: InjectedKeyValue,
    options: UpstashResearchPersistenceOptions = {}
  ) {
    this.prefix = options.prefix ?? "stocksage:greenfield:research:v1";
    this.ttlSeconds = options.ttlSeconds;
  }

  private key(runId: string): string {
    return `${this.prefix}:${runId}`;
  }

  private options(extra: { nx?: boolean } = {}):
    | { nx?: boolean; ex?: number }
    | undefined {
    if (!extra.nx && this.ttlSeconds === undefined) return undefined;
    return {
      ...extra,
      ...(this.ttlSeconds === undefined ? {} : { ex: this.ttlSeconds }),
    };
  }

  async create(record: ResearchRunRecord): Promise<boolean> {
    const result = await this.kv.set(
      this.key(record.runId),
      JSON.stringify(record),
      this.options({ nx: true })
    );
    return result !== null && result !== false;
  }

  async save(record: ResearchRunRecord): Promise<void> {
    await this.kv.set(
      this.key(record.runId),
      JSON.stringify(record),
      this.options()
    );
  }

  async load(runId: string): Promise<ResearchRunRecord | null> {
    const value = await this.kv.get(this.key(runId));
    if (value == null) return null;
    try {
      const parsed =
        typeof value === "string" ? JSON.parse(value) : value;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as ResearchRunRecord).version !== 1
      ) {
        return null;
      }
      return clone(parsed as ResearchRunRecord);
    } catch {
      return null;
    }
  }
}

export interface LaneExecutionContext {
  runId: string;
  question: string;
  asOf: string;
  signal: AbortSignal;
  remainingTimeMs: number;
  remainingCost: number;
}

export interface LaneExecutionResult {
  evidence: readonly ResearchEvidence[];
  cost?: number;
}

export type ResearchLaneExecutor = (
  lane: EvidenceLane,
  context: LaneExecutionContext
) => Promise<LaneExecutionResult>;

export interface ResearchOrchestratorOptions {
  persistence: ResearchPersistence;
  executeLane: ResearchLaneExecutor;
  signal?: AbortSignal;
  onProgress?: (event: ResearchProgressEvent) => void | Promise<void>;
  now?: () => number;
}

async function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw new Error(abortReason(signal) ?? "research_cancelled");
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        onAbort = () =>
          reject(new Error(abortReason(signal) ?? "research_cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  return typeof reason === "string"
    ? reason
    : reason instanceof Error
      ? reason.message
      : undefined;
}

function mergeAbortSignal(
  external: AbortSignal | undefined,
  deadlineMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(external ? external.reason : "cancelled");
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort("research_time_budget_exhausted"),
    Math.max(0, deadlineMs)
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

function sanitizeEvidence(
  evidence: readonly ResearchEvidence[],
  lane: EvidenceLane
): ResearchEvidence[] {
  const seen = new Set<string>();
  const limit = lane.maxItems ?? evidence.length;
  return evidence
    .filter((item) => {
      if (!item.id || !item.sourceId || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, limit)
    .map((item) => ({ ...item, laneId: item.laneId ?? lane.id }));
}

function deduplicateEvidence(
  items: readonly ResearchEvidence[]
): ResearchEvidence[] {
  const byId = new Map<string, ResearchEvidence>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * Runs lanes in bounded parallel batches. Sufficiency is checked after each
 * batch, so no later batch starts once the evidence target is met.
 */
export async function runResearchPlan(
  plan: ResearchPlan,
  options: ResearchOrchestratorOptions
): Promise<ResearchRunRecord> {
  const now = options.now ?? Date.now;
  const acceptedAt = new Date(now()).toISOString();
  const record: ResearchRunRecord = {
    version: 1,
    runId: plan.id,
    plan,
    state: "accepted",
    acceptedAt,
    updatedAt: acceptedAt,
    stepsUsed: 0,
    costUsed: 0,
    completedLaneIds: [],
    evidence: [],
    progress: [],
  };

  const publish = async (event: ResearchProgressEvent): Promise<void> => {
    record.progress.push(event);
    record.updatedAt = event.at;
    await options.persistence.save(record);
    await options.onProgress?.(event);
  };

  const created = await options.persistence.create(record);
  if (!created) {
    const existing = await options.persistence.load(plan.id);
    if (existing) return existing;
    throw new Error(`Research run ${plan.id} already exists`);
  }
  await publish({ type: "accepted", runId: plan.id, at: acceptedAt });
  record.state = "running";
  await publish({
    type: "started",
    runId: plan.id,
    at: new Date(now()).toISOString(),
  });

  const startedAtMs = now();
  const merged = mergeAbortSignal(options.signal, plan.limits.maxTimeMs);
  let nextLane = 0;

  try {
    while (nextLane < plan.lanes.length) {
      if (merged.signal.aborted) break;
      if (record.stepsUsed >= plan.limits.maxSteps) {
        await publish({
          type: "budget_exhausted",
          runId: plan.id,
          at: new Date(now()).toISOString(),
          budget: "steps",
        });
        break;
      }
      if (now() - startedAtMs >= plan.limits.maxTimeMs) break;

      const batch: Array<{ lane: EvidenceLane; step: number }> = [];
      while (
        nextLane < plan.lanes.length &&
        batch.length < plan.limits.maxParallel &&
        record.stepsUsed + batch.length < plan.limits.maxSteps
      ) {
        const lane = plan.lanes[nextLane++];
        const estimate = lane.estimatedCost ?? 1;
        const reserved = batch.reduce(
          (sum, item) => sum + (item.lane.estimatedCost ?? 1),
          0
        );
        if (record.costUsed + reserved + estimate > plan.limits.maxCost) {
          continue;
        }
        batch.push({ lane, step: record.stepsUsed + batch.length + 1 });
      }

      if (batch.length === 0) {
        await publish({
          type: "budget_exhausted",
          runId: plan.id,
          at: new Date(now()).toISOString(),
          budget: "cost",
        });
        break;
      }

      for (const item of batch) {
        await publish({
          type: "lane_started",
          runId: plan.id,
          at: new Date(now()).toISOString(),
          laneId: item.lane.id,
          step: item.step,
        });
      }

      const outcomes = await Promise.all(
        batch.map(async ({ lane, step }) => {
          try {
            const result = await withAbort(
              options.executeLane(lane, {
                runId: plan.id,
                question: plan.question,
                asOf: plan.asOf,
                signal: merged.signal,
                remainingTimeMs: Math.max(
                  0,
                  plan.limits.maxTimeMs - (now() - startedAtMs)
                ),
                remainingCost: Math.max(
                  0,
                  plan.limits.maxCost - record.costUsed
                ),
              }),
              merged.signal
            );
            return {
              ok: true as const,
              lane,
              step,
              evidence: sanitizeEvidence(result.evidence, lane),
              cost: nonNegative(
                result.cost ?? lane.estimatedCost ?? 1,
                lane.estimatedCost ?? 1
              ),
            };
          } catch (error) {
            return {
              ok: false as const,
              lane,
              step,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );

      for (const outcome of outcomes) {
        record.stepsUsed += 1;
        if (outcome.ok) {
          record.costUsed += outcome.cost;
          record.completedLaneIds.push(outcome.lane.id);
          record.evidence = deduplicateEvidence([
            ...record.evidence,
            ...outcome.evidence,
          ]);
          await publish({
            type: "lane_completed",
            runId: plan.id,
            at: new Date(now()).toISOString(),
            laneId: outcome.lane.id,
            step: outcome.step,
            evidenceCount: outcome.evidence.length,
            cost: outcome.cost,
          });
        } else {
          await publish({
            type: "lane_failed",
            runId: plan.id,
            at: new Date(now()).toISOString(),
            laneId: outcome.lane.id,
            step: outcome.step,
            error: outcome.error,
          });
        }
      }

      record.sufficiency = evaluateEvidenceSufficiency({
        evidence: record.evidence,
        completedLaneIds: record.completedLaneIds,
        policy: plan.sufficiency,
      });
      await publish({
        type: "sufficiency_checked",
        runId: plan.id,
        at: new Date(now()).toISOString(),
        result: record.sufficiency,
      });
      if (record.sufficiency.sufficient) break;
      if (record.costUsed >= plan.limits.maxCost) {
        await publish({
          type: "budget_exhausted",
          runId: plan.id,
          at: new Date(now()).toISOString(),
          budget: "cost",
        });
        break;
      }
    }

    if (merged.signal.aborted) {
      const timedOut =
        abortReason(merged.signal) === "research_time_budget_exhausted" ||
        now() - startedAtMs >= plan.limits.maxTimeMs;
      if (timedOut) {
        await publish({
          type: "budget_exhausted",
          runId: plan.id,
          at: new Date(now()).toISOString(),
          budget: "time",
        });
      } else {
        record.state = "cancelled";
        await publish({
          type: "cancelled",
          runId: plan.id,
          at: new Date(now()).toISOString(),
          reason: abortReason(merged.signal),
        });
      }
    }

    record.sufficiency =
      record.sufficiency ??
      evaluateEvidenceSufficiency({
        evidence: record.evidence,
        completedLaneIds: record.completedLaneIds,
        policy: plan.sufficiency,
      });
    if (record.state !== "cancelled") record.state = "completed";
    record.finishedAt = new Date(now()).toISOString();
    await publish({
      type: "completed",
      runId: plan.id,
      at: record.finishedAt,
      sufficient: record.sufficiency.sufficient,
    });
    return clone(record);
  } catch (error) {
    record.state = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.finishedAt = new Date(now()).toISOString();
    record.updatedAt = record.finishedAt;
    await options.persistence.save(record);
    return clone(record);
  } finally {
    merged.dispose();
  }
}

export const orchestrateResearch = runResearchPlan;

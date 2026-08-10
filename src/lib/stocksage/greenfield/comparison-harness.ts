import type { PairwiseAggregate, PairwiseRubricRecord } from "./pairwise";
import { aggregatePairwiseRecords } from "./pairwise";

export const COMPARISON_ARTIFACT_VERSION = 2 as const;

export type ComparisonPhase = "generate" | "judge" | "all";
export type CandidateId = "current" | "greenfield";
export type RateLimitKind = "tokens_per_minute" | "tokens_per_day" | "other";

export type CandidateFailure = {
  status?: number;
  message: string;
  rateLimitKind?: RateLimitKind;
  retryAfterMs?: number;
};

export type CandidateCheckpoint = {
  id: CandidateId;
  status: "success" | "failed";
  answer: string;
  completedAt: string;
  failure?: CandidateFailure;
  diagnostics?: unknown;
};

export type CaseJudgeCheckpoint = {
  status: "success" | "failed";
  completedAt: string;
  record?: PairwiseRubricRecord;
  error?: string;
};

export type CaseCheckpoint = {
  caseId: string;
  family: string;
  executionOrder: readonly [CandidateId, CandidateId];
  candidates: Partial<Record<CandidateId, CandidateCheckpoint>>;
  judge?: CaseJudgeCheckpoint;
};

export type ComparisonArtifact = {
  version: typeof COMPARISON_ARTIFACT_VERSION;
  seed: string;
  createdAt: string;
  updatedAt: string;
  phase: ComparisonPhase;
  blindCaseIds: readonly string[];
  delayMs: number;
  cases: CaseCheckpoint[];
  records: PairwiseRubricRecord[];
  aggregate: PairwiseAggregate;
  stopReason?: string | null;
};

export type ParsePhaseResult =
  | { ok: true; phase: ComparisonPhase }
  | { ok: false; error: string };

export function parseComparisonPhase(
  value: string | undefined
): ParsePhaseResult {
  const phase = (value ?? "all").trim().toLowerCase();
  if (phase === "generate" || phase === "judge" || phase === "all") {
    return { ok: true, phase };
  }
  return {
    ok: false,
    error: `Invalid --phase=${value ?? ""}. Expected generate, judge, or all.`,
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministically choose whether current or greenfield executes first.
 * Persisting this removes fixed current-then-greenfield quota bias.
 */
export function chooseCandidateExecutionOrder(
  seed: string,
  caseId: string
): readonly [CandidateId, CandidateId] {
  const swap = (hashString(`${seed}:exec:${caseId}`) & 1) === 1;
  return swap
    ? (["greenfield", "current"] as const)
    : (["current", "greenfield"] as const);
}

export function classifyRateLimitFailure(input: {
  status?: number;
  message?: string;
  retryAfterMs?: number;
}): RateLimitKind | undefined {
  if (input.status !== 429) return undefined;
  const message = input.message ?? "";
  if (/tokens per day|\bTPD\b/i.test(message)) return "tokens_per_day";
  if (/tokens per minute|\bTPM\b/i.test(message)) return "tokens_per_minute";
  return "other";
}

/** Strip provider JSON bodies while keeping the status/classifying cue. */
export function sanitizeProviderErrorMessage(message: string): string {
  const withoutSecrets = message
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9]+/g, "[redacted-key]");
  // Drop embedded provider JSON objects; keep the HTTP/status prefix and any
  // trailing plain-text classification cues (TPM/TPD) when present outside JSON.
  const withoutJson = withoutSecrets
    .replace(/\{[^{}]*\}/g, "")
    .replace(/:\s*\{[\s\S]*\}/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
  const condensed = withoutJson.replace(/\s+/g, " ");
  return condensed.length > 280 ? `${condensed.slice(0, 277)}...` : condensed;
}

export function summarizeCandidateFailure(error: unknown): CandidateFailure {
  const withMeta = error as {
    status?: number;
    retryAfterMs?: number;
    message?: string;
  };
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof withMeta.message === "string"
        ? withMeta.message
        : String(error);
  const status =
    typeof withMeta.status === "number" ? withMeta.status : undefined;
  const retryAfterMs =
    typeof withMeta.retryAfterMs === "number" &&
    Number.isFinite(withMeta.retryAfterMs)
      ? withMeta.retryAfterMs
      : undefined;
  const message = sanitizeProviderErrorMessage(rawMessage);
  const rateLimitKind = classifyRateLimitFailure({
    status,
    message: rawMessage,
    retryAfterMs,
  });
  return {
    ...(status !== undefined ? { status } : {}),
    message,
    ...(rateLimitKind ? { rateLimitKind } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function isSuccessfulCandidate(
  candidate: CandidateCheckpoint | undefined
): candidate is CandidateCheckpoint & { status: "success" } {
  return candidate?.status === "success" && candidate.answer.trim().length > 0;
}

export function shouldRegenerateCandidate(
  candidate: CandidateCheckpoint | undefined
): boolean {
  return !isSuccessfulCandidate(candidate);
}

export function isPairReadyForJudging(caseResult: CaseCheckpoint): boolean {
  return (
    isSuccessfulCandidate(caseResult.candidates.current) &&
    isSuccessfulCandidate(caseResult.candidates.greenfield)
  );
}

export function shouldJudgeCase(
  caseResult: CaseCheckpoint,
  options: { force?: boolean } = {}
): boolean {
  if (!isPairReadyForJudging(caseResult)) return false;
  if (options.force) return true;
  return caseResult.judge?.status !== "success";
}

export function completedJudgeRecords(
  cases: readonly CaseCheckpoint[]
): PairwiseRubricRecord[] {
  return cases
    .map((item) => item.judge)
    .filter(
      (judge): judge is CaseJudgeCheckpoint & { record: PairwiseRubricRecord } =>
        judge?.status === "success" && judge.record !== undefined
    )
    .map((judge) => judge.record);
}

export function deriveComparisonAggregate(
  cases: readonly CaseCheckpoint[]
): PairwiseAggregate {
  return aggregatePairwiseRecords(completedJudgeRecords(cases));
}

export type ResumeDecision =
  | { action: "keep"; candidate: CandidateCheckpoint }
  | { action: "generate" };

export function resumeCandidateDecision(
  existing: CandidateCheckpoint | undefined
): ResumeDecision {
  if (isSuccessfulCandidate(existing)) {
    return { action: "keep", candidate: existing };
  }
  return { action: "generate" };
}

export function mergeCaseCheckpoint(
  existing: CaseCheckpoint | undefined,
  patch: Partial<CaseCheckpoint> & Pick<CaseCheckpoint, "caseId" | "family">
): CaseCheckpoint {
  const executionOrder =
    patch.executionOrder ??
    existing?.executionOrder ??
    chooseCandidateExecutionOrder("", patch.caseId);
  return {
    caseId: patch.caseId,
    family: patch.family,
    executionOrder: [...executionOrder] as [CandidateId, CandidateId],
    candidates: {
      ...(existing?.candidates ?? {}),
      ...(patch.candidates ?? {}),
    },
    ...(patch.judge !== undefined
      ? { judge: patch.judge }
      : existing?.judge
        ? { judge: existing.judge }
        : {}),
  };
}

export function ensureCaseSkeleton(args: {
  caseId: string;
  family: string;
  seed: string;
  existing?: CaseCheckpoint;
}): CaseCheckpoint {
  if (args.existing) {
    return {
      ...args.existing,
      family: args.existing.family || args.family,
      executionOrder:
        args.existing.executionOrder ??
        chooseCandidateExecutionOrder(args.seed, args.caseId),
      candidates: { ...args.existing.candidates },
    };
  }
  return {
    caseId: args.caseId,
    family: args.family,
    executionOrder: chooseCandidateExecutionOrder(args.seed, args.caseId),
    candidates: {},
  };
}

export function parseComparisonArtifact(
  value: unknown
): ComparisonArtifact | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ComparisonArtifact>;
  if (raw.version !== COMPARISON_ARTIFACT_VERSION) return null;
  if (typeof raw.seed !== "string" || !Array.isArray(raw.cases)) return null;
  return {
    version: COMPARISON_ARTIFACT_VERSION,
    seed: raw.seed,
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date(0).toISOString(),
    phase:
      raw.phase === "generate" || raw.phase === "judge" || raw.phase === "all"
        ? raw.phase
        : "all",
    blindCaseIds: Array.isArray(raw.blindCaseIds)
      ? raw.blindCaseIds.filter((id): id is string => typeof id === "string")
      : [],
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 0,
    cases: raw.cases as CaseCheckpoint[],
    records: Array.isArray(raw.records)
      ? (raw.records as PairwiseRubricRecord[])
      : [],
    aggregate:
      raw.aggregate ??
      deriveComparisonAggregate((raw.cases as CaseCheckpoint[]) ?? []),
    stopReason: raw.stopReason ?? null,
  };
}

export function buildComparisonArtifact(args: {
  seed: string;
  phase: ComparisonPhase;
  blindCaseIds: readonly string[];
  delayMs: number;
  cases: CaseCheckpoint[];
  createdAt?: string;
  updatedAt?: string;
  stopReason?: string | null;
}): ComparisonArtifact {
  const records = completedJudgeRecords(args.cases);
  return {
    version: COMPARISON_ARTIFACT_VERSION,
    seed: args.seed,
    createdAt: args.createdAt ?? new Date().toISOString(),
    updatedAt: args.updatedAt ?? new Date().toISOString(),
    phase: args.phase,
    blindCaseIds: [...args.blindCaseIds],
    delayMs: args.delayMs,
    cases: args.cases,
    records,
    aggregate: aggregatePairwiseRecords(records),
    stopReason: args.stopReason ?? null,
  };
}

export type RateLimitRetryDecision =
  | { action: "retry"; waitMs: number }
  | { action: "abort"; reason: "tokens_per_day" | "exhausted_retries" | "non_retryable"; failure: CandidateFailure };

/**
 * Adaptive 429 handling: wait only for TPM/other short windows.
 * Never sleep through tokens-per-day exhaustion.
 */
export function decideRateLimitRetry(args: {
  error: unknown;
  attempt: number;
  maxAttempts: number;
  maxWaitMs?: number;
}): RateLimitRetryDecision {
  const failure = summarizeCandidateFailure(args.error);
  const maxWaitMs = args.maxWaitMs ?? 60_000;
  if (failure.status !== 429) {
    return { action: "abort", reason: "non_retryable", failure };
  }
  if (failure.rateLimitKind === "tokens_per_day") {
    return { action: "abort", reason: "tokens_per_day", failure };
  }
  if (args.attempt >= args.maxAttempts - 1) {
    return { action: "abort", reason: "exhausted_retries", failure };
  }
  const waitMs = Math.min(
    maxWaitMs,
    Math.max(1_000, failure.retryAfterMs ?? 10_000)
  );
  if ((failure.retryAfterMs ?? waitMs) > maxWaitMs) {
    return { action: "abort", reason: "exhausted_retries", failure };
  }
  return { action: "retry", waitMs: waitMs + 250 };
}

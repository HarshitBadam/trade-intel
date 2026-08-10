import type {
  EvidenceFact,
  ResearchEvidence,
} from "./research";
import {
  canonicalInstrumentAliases,
  instrumentAliasesOverlap,
} from "./evidence-identity";

export type AnswerDepth = "glance" | "standard" | "detailed" | "deep";
export type UserDepthPreference =
  | AnswerDepth
  | "auto"
  | "concise"
  | "balanced"
  | "thorough";
export type TaskComplexity =
  | "atomic"
  | "simple"
  | "moderate"
  | "complex"
  | "research";

export interface DepthSelectionInput {
  question?: string;
  preference?: UserDepthPreference;
  complexity?: TaskComplexity | number;
  evidenceCount?: number;
  entityCount?: number;
  multiStep?: boolean;
  comparison?: boolean;
  causal?: boolean;
  requiresResearch?: boolean;
}

export interface DepthDecision {
  depth: AnswerDepth;
  score: number;
  reasons: string[];
}

const COMPLEXITY_SCORE: Record<TaskComplexity, number> = {
  atomic: 0,
  simple: 1,
  moderate: 3,
  complex: 5,
  research: 7,
};

const DEPTHS: AnswerDepth[] = ["glance", "standard", "detailed", "deep"];

function clampScore(score: number): number {
  return Math.max(0, Math.min(9, Number.isFinite(score) ? score : 0));
}

function scoreToDepth(score: number): AnswerDepth {
  if (score <= 1) return "glance";
  if (score <= 3) return "standard";
  if (score <= 6) return "detailed";
  return "deep";
}

function inferredComplexity(question: string): TaskComplexity {
  const normalized = question.trim();
  if (
    /^(?:what is|calculate|compute|convert)\b/i.test(normalized) &&
    !/\b(?:compare|why|outlook|scenario|risks?|research|investigate)\b/i.test(
      normalized
    )
  ) {
    return "atomic";
  }
  if (
    /\b(?:deep dive|research|investigate|thesis|scenario analysis)\b/i.test(
      normalized
    )
  ) {
    return "research";
  }
  if (
    /\b(?:compare|versus|vs\.?|why|caused|risks? and|bull and bear)\b/i.test(
      normalized
    )
  ) {
    return "complex";
  }
  return normalized.split(/\s+/).length > 18 ? "moderate" : "simple";
}

export function decideAnswerDepth(input: DepthSelectionInput): DepthDecision {
  if (
    input.preference &&
    DEPTHS.includes(input.preference as AnswerDepth)
  ) {
    return {
      depth: input.preference as AnswerDepth,
      score: DEPTHS.indexOf(input.preference as AnswerDepth) * 3,
      reasons: ["explicit_user_depth"],
    };
  }

  const complexity =
    input.complexity ??
    inferredComplexity(input.question ?? "");
  let score =
    typeof complexity === "number"
      ? clampScore(complexity)
      : COMPLEXITY_SCORE[complexity];
  const reasons = [`complexity:${String(complexity)}`];

  if (input.multiStep) {
    score += 2;
    reasons.push("multi_step");
  }
  if (input.comparison || (input.entityCount ?? 0) > 1) {
    score += 1;
    reasons.push("comparison");
  }
  if (input.causal) {
    score += 1;
    reasons.push("causal");
  }
  if (input.requiresResearch) {
    score += 2;
    reasons.push("research_required");
  }
  if ((input.evidenceCount ?? 0) >= 8) {
    score += 1;
    reasons.push("large_evidence_set");
  }
  if (input.preference === "concise") {
    score -= 2;
    reasons.push("user_prefers_concise");
  } else if (input.preference === "thorough") {
    score += 2;
    reasons.push("user_prefers_thorough");
  }

  score = clampScore(score);
  return { depth: scoreToDepth(score), score, reasons };
}

export function selectAnswerDepth(input: DepthSelectionInput): AnswerDepth {
  return decideAnswerDepth(input).depth;
}

export type NumericOperation =
  | "sum"
  | "difference"
  | "product"
  | "ratio"
  | "average"
  | "minimum"
  | "maximum"
  | "percent_change";

export interface NumericOperand {
  value?: number;
  evidenceId?: string;
  factKey?: string;
}

export interface AtomicNumericTask {
  operation: NumericOperation;
  operands: readonly NumericOperand[];
  label?: string;
  currency?: string;
  unit?: string;
  precision?: number;
}

export interface FactReference {
  evidenceId: string;
  factKey: string;
}

export interface NumericCalculation {
  operation: NumericOperation;
  operands: readonly FactReference[];
  result: number;
  tolerance?: number;
}

export type ClaimKind = "factual" | "derived" | "inference" | "opinion";

export interface ComposedClaim {
  id: string;
  text: string;
  kind?: ClaimKind;
  evidenceIds?: readonly string[];
  factRefs?: readonly FactReference[];
  /** Proposition key expected in ResearchEvidence.supports. */
  supportKey?: string;
  calculation?: NumericCalculation;
  instrument?: string;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface ComposerDraft {
  overview?: string;
  claims: readonly ComposedClaim[];
}

export interface ComposerInput {
  question: string;
  depth: AnswerDepth;
  evidence: readonly ResearchEvidence[];
  evidenceIds: readonly string[];
  instructions: string;
}

export interface ComposerModel {
  compose(input: ComposerInput): Promise<ComposerDraft>;
}

export type InjectedComposer =
  | ComposerModel
  | ((input: ComposerInput) => Promise<ComposerDraft>);

export interface AnswerAlignment {
  asOf?: string;
  instruments?: readonly string[];
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
}

export type VerificationIssueCode =
  | "missing_claim_citation"
  | "unknown_evidence"
  | "unsupported_claim"
  | "numeric_not_reproducible"
  | "look_ahead_evidence"
  | "instrument_mismatch"
  | "currency_mismatch"
  | "time_mismatch";

export interface VerificationIssue {
  claimId: string;
  code: VerificationIssueCode;
  action: "removed" | "qualified";
  detail: string;
}

export interface VerifiedClaim extends ComposedClaim {
  evidenceIds: readonly string[];
  qualified: boolean;
}

export interface VerificationResult {
  passed: boolean;
  claims: VerifiedClaim[];
  issues: VerificationIssue[];
  removedClaimIds: string[];
}

export interface AdaptiveAnswer {
  mode: "atomic_numeric" | "composed";
  depth: AnswerDepth;
  text: string;
  claims: readonly VerifiedClaim[];
  evidenceIds: readonly string[];
  verification: VerificationResult;
  numeric?: {
    value: number;
    operation: NumericOperation;
    currency?: string;
    unit?: string;
  };
}

export interface AdaptiveAnswerRequest extends DepthSelectionInput {
  question: string;
  evidence?: readonly ResearchEvidence[];
  numericTask?: AtomicNumericTask;
  composer?: InjectedComposer;
  alignment?: AnswerAlignment;
  unsupportedPolicy?: "remove" | "qualify";
  /**
   * Allows a cited prose claim over freshness-scoped document evidence to be
   * explicitly qualified. Numeric and derived claims still require exact,
   * reproducible fact references.
   */
  allowQualifiedNarrativeClaims?: boolean;
}

function evidenceMap(
  evidence: readonly ResearchEvidence[]
): Map<string, ResearchEvidence> {
  return new Map(evidence.map((item) => [item.id, item]));
}

function citationText(
  ids: readonly string[],
  evidence: Map<string, ResearchEvidence>
): string {
  if (ids.length === 0) return "";
  const labels = ids.map((id) => {
    const item = evidence.get(id);
    return item?.sourceUrl
      ? `[${item.sourceId || id}](${item.sourceUrl})`
      : `[${id}]`;
  });
  return ` ${labels.join(" ")}`;
}

function referencedFact(
  reference: FactReference,
  evidence: Map<string, ResearchEvidence>
): EvidenceFact | null {
  return evidence.get(reference.evidenceId)?.facts?.[reference.factKey] ?? null;
}

function resolveOperand(
  operand: NumericOperand,
  evidence: Map<string, ResearchEvidence>
): number | null {
  if (typeof operand.value === "number" && Number.isFinite(operand.value)) {
    return operand.value;
  }
  if (!operand.evidenceId || !operand.factKey) return null;
  const value = evidence.get(operand.evidenceId)?.facts?.[operand.factKey]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function calculateNumeric(
  operation: NumericOperation,
  values: readonly number[]
): number | null {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  let result: number;
  switch (operation) {
    case "sum":
      result = values.reduce((sum, value) => sum + value, 0);
      break;
    case "difference":
      if (values.length !== 2) return null;
      result = values[0] - values[1];
      break;
    case "product":
      result = values.reduce((product, value) => product * value, 1);
      break;
    case "ratio":
      if (values.length !== 2 || values[1] === 0) return null;
      result = values[0] / values[1];
      break;
    case "average":
      result =
        values.reduce((sum, value) => sum + value, 0) / values.length;
      break;
    case "minimum":
      result = Math.min(...values);
      break;
    case "maximum":
      result = Math.max(...values);
      break;
    case "percent_change":
      if (values.length !== 2 || values[0] === 0) return null;
      result = ((values[1] - values[0]) / Math.abs(values[0])) * 100;
      break;
  }
  return Number.isFinite(result) ? result : null;
}

function formatNumeric(
  value: number,
  task: Pick<AtomicNumericTask, "currency" | "unit" | "precision">
): string {
  const precision = Math.max(0, Math.min(10, task.precision ?? 2));
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
    useGrouping: false,
  });
  if (task.unit === "%") return `${formatted}%`;
  if (task.currency) return `${task.currency} ${formatted}`;
  return task.unit ? `${formatted} ${task.unit}` : formatted;
}

export function tryAtomicNumericAnswer(args: {
  task: AtomicNumericTask;
  evidence?: readonly ResearchEvidence[];
  alignment?: AnswerAlignment;
}): AdaptiveAnswer | null {
  const evidence = args.evidence ?? [];
  const indexed = evidenceMap(evidence);
  const values = args.task.operands.map((operand) =>
    resolveOperand(operand, indexed)
  );
  if (values.some((value) => value === null)) return null;
  const result = calculateNumeric(
    args.task.operation,
    values as number[]
  );
  if (result === null) return null;
  const ids = [
    ...new Set(
      args.task.operands
        .map((operand) => operand.evidenceId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const text = `${args.task.label ? `${args.task.label}: ` : ""}${formatNumeric(
    result,
    args.task
  )}${citationText(ids, indexed)}`;
  const claim: VerifiedClaim = {
    id: "atomic-result",
    text,
    kind: "derived",
    evidenceIds: ids,
    factRefs: args.task.operands
      .filter(
        (
          operand
        ): operand is NumericOperand & {
          evidenceId: string;
          factKey: string;
        } => Boolean(operand.evidenceId && operand.factKey)
      )
      .map((operand) => ({
        evidenceId: operand.evidenceId,
        factKey: operand.factKey,
      })),
    calculation:
      args.task.operands.every(
        (operand) => operand.evidenceId && operand.factKey
      )
        ? {
            operation: args.task.operation,
            operands: args.task.operands.map((operand) => ({
              evidenceId: operand.evidenceId as string,
              factKey: operand.factKey as string,
            })),
            result,
          }
        : undefined,
    currency: args.task.currency,
    qualified: false,
  };
  const verification: VerificationResult =
    ids.length === 0
      ? {
          passed: true,
          claims: [claim],
          issues: [],
          removedClaimIds: [],
        }
      : verifyComposedAnswer({
          draft: { claims: [claim] },
          evidence,
          alignment: args.alignment,
        });
  if (verification.claims.length === 0) return null;
  return {
    mode: "atomic_numeric",
    depth: "glance",
    text,
    claims: verification.claims,
    evidenceIds: ids,
    verification,
    numeric: {
      value: result,
      operation: args.task.operation,
      currency: args.task.currency,
      unit: args.task.unit,
    },
  };
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function periodsOverlap(
  leftStart: string | undefined,
  leftEnd: string | undefined,
  rightStart: string | undefined,
  rightEnd: string | undefined
): boolean {
  const leftFrom = timestamp(leftStart) ?? Number.NEGATIVE_INFINITY;
  const leftTo = timestamp(leftEnd) ?? Number.POSITIVE_INFINITY;
  const rightFrom = timestamp(rightStart) ?? Number.NEGATIVE_INFINITY;
  const rightTo = timestamp(rightEnd) ?? Number.POSITIVE_INFINITY;
  return leftFrom <= rightTo && rightFrom <= leftTo;
}

function claimReferences(claim: ComposedClaim): FactReference[] {
  return [
    ...(claim.factRefs ?? []),
    ...(claim.calculation?.operands ?? []),
  ].filter(
    (reference, index, all) =>
      all.findIndex(
        (item) =>
          item.evidenceId === reference.evidenceId &&
          item.factKey === reference.factKey
      ) === index
  );
}

function citedEvidenceIds(claim: ComposedClaim): string[] {
  return [
    ...new Set([
      ...(claim.evidenceIds ?? []),
      ...claimReferences(claim).map((reference) => reference.evidenceId),
    ]),
  ];
}

function effectiveField(
  evidence: ResearchEvidence,
  references: readonly FactReference[],
  field: "instrument" | "currency" | "periodStart" | "periodEnd"
): string | undefined {
  const factValue = references
    .filter((reference) => reference.evidenceId === evidence.id)
    .map((reference) => evidence.facts?.[reference.factKey]?.[field])
    .find(Boolean);
  return factValue ?? evidence[field];
}

function effectiveInstrumentAliases(
  evidence: ResearchEvidence,
  references: readonly FactReference[]
): string[] {
  return canonicalInstrumentAliases([
    effectiveField(evidence, references, "instrument"),
    evidence.providerSymbol,
    evidence.instrument,
    ...(evidence.instrumentAliases ?? []),
  ]);
}

function isLookAhead(
  evidence: ResearchEvidence,
  references: readonly FactReference[],
  asOf: string | undefined
): boolean {
  const cutoff = timestamp(asOf);
  if (cutoff === null) return false;
  const availability = [
    evidence.availableAt,
    ...references
      .filter((reference) => reference.evidenceId === evidence.id)
      .map(
        (reference) =>
          evidence.facts?.[reference.factKey]?.availableAt
      ),
  ]
    .map(timestamp)
    .filter((value): value is number => value !== null);
  return availability.some((value) => value > cutoff);
}

function numericCalculationValid(
  calculation: NumericCalculation,
  evidence: Map<string, ResearchEvidence>,
  allowedEvidenceIds?: ReadonlySet<string>
): boolean {
  if (
    allowedEvidenceIds &&
    calculation.operands.some(
      (reference) => !allowedEvidenceIds.has(reference.evidenceId)
    )
  ) {
    return false;
  }
  const values = calculation.operands.map((reference) => {
    const value = referencedFact(reference, evidence)?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  if (values.some((value) => value === null)) return false;
  const reproduced = calculateNumeric(
    calculation.operation,
    values as number[]
  );
  if (reproduced === null) return false;
  const tolerance =
    calculation.tolerance ??
    Math.max(1e-9, Math.abs(calculation.result) * 1e-9);
  return Math.abs(reproduced - calculation.result) <= tolerance;
}

function directSupport(
  claim: ComposedClaim,
  cited: readonly ResearchEvidence[],
  indexed: Map<string, ResearchEvidence>
): boolean {
  const citedIds = new Set(cited.map((item) => item.id));
  if (claim.calculation) {
    return numericCalculationValid(claim.calculation, indexed, citedIds);
  }
  const references = claimReferences(claim);
  if (references.length > 0) {
    return references.every(
      (reference) =>
        citedIds.has(reference.evidenceId) &&
        referencedFact(reference, indexed) !== null
    );
  }
  if (claim.supportKey) {
    return cited.some((item) => item.supports?.includes(claim.supportKey!));
  }
  return false;
}

function qualification(text: string): string {
  return /^The available evidence (?:suggests|indicates)/i.test(text)
    ? text
    : `The available evidence suggests that ${text
        .trim()
        .replace(/^[A-Z]/, (value) => value.toLowerCase())}`;
}

function containsMaterialNumericAssertion(text: string): boolean {
  return /(?:[$€£¥]\s*\d|\b\d+(?:\.\d+)?\s*(?:%|percent|percentage points?|bps|basis points?|million|billion|trillion|shares?|dollars?|euros?|pounds?))/i.test(
    text
  );
}

function pushIssue(
  issues: VerificationIssue[],
  claim: ComposedClaim,
  code: VerificationIssueCode,
  action: VerificationIssue["action"],
  detail: string
): void {
  issues.push({ claimId: claim.id, code, action, detail });
}

/**
 * Deterministic publication gate. It only uses structured claims and evidence;
 * it does not call a second model.
 */
export function verifyComposedAnswer(args: {
  draft: ComposerDraft;
  evidence: readonly ResearchEvidence[];
  alignment?: AnswerAlignment;
  unsupportedPolicy?: "remove" | "qualify";
  allowQualifiedNarrativeClaims?: boolean;
}): VerificationResult {
  const indexed = evidenceMap(args.evidence);
  const issues: VerificationIssue[] = [];
  const kept: VerifiedClaim[] = [];
  const removed = new Set<string>();

  for (const original of args.draft.claims) {
    let claim = { ...original };
    let ids = citedEvidenceIds(claim);
    const unknown = ids.filter((id) => !indexed.has(id));
    if (unknown.length > 0) {
      ids = ids.filter((id) => indexed.has(id));
      pushIssue(
        issues,
        claim,
        "unknown_evidence",
        ids.length === 0 ? "removed" : "qualified",
        `Unknown evidence IDs: ${unknown.join(", ")}`
      );
    }
    let cited = ids
      .map((id) => indexed.get(id))
      .filter((item): item is ResearchEvidence => Boolean(item));
    const references = claimReferences(claim);

    const lookAheadIds = cited
      .filter((item) =>
        isLookAhead(item, references, args.alignment?.asOf)
      )
      .map((item) => item.id);
    if (lookAheadIds.length > 0) {
      ids = ids.filter((id) => !lookAheadIds.includes(id));
      cited = cited.filter((item) => !lookAheadIds.includes(item.id));
      pushIssue(
        issues,
        claim,
        "look_ahead_evidence",
        ids.length === 0 ? "removed" : "qualified",
        `Evidence unavailable at the answer cutoff: ${lookAheadIds.join(", ")}`
      );
    }

    const kind = claim.kind ?? "factual";
    if (kind !== "opinion" && ids.length === 0) {
      pushIssue(
        issues,
        claim,
        "missing_claim_citation",
        "removed",
        "Factual and derived claims require a claim-level evidence ID"
      );
      removed.add(claim.id);
      continue;
    }

    const alignedAliases = canonicalInstrumentAliases(
      args.alignment?.instruments ?? []
    );
    const instrumentMismatch =
      (claim.instrument !== undefined &&
        alignedAliases.length > 0 &&
        !instrumentAliasesOverlap([claim.instrument], alignedAliases)) ||
      cited.some((item) => {
        const evidenceAliases = effectiveInstrumentAliases(item, references);
        if (evidenceAliases.length === 0) return false;
        return (
          (claim.instrument !== undefined &&
            !instrumentAliasesOverlap([claim.instrument], evidenceAliases)) ||
          (alignedAliases.length > 0 &&
            !instrumentAliasesOverlap(evidenceAliases, alignedAliases))
        );
      });
    if (instrumentMismatch) {
      pushIssue(
        issues,
        claim,
        "instrument_mismatch",
        "removed",
        "Claim and evidence refer to different instruments"
      );
      removed.add(claim.id);
      continue;
    }

    const currencyMismatch =
      (claim.currency !== undefined &&
        args.alignment?.currency !== undefined &&
        claim.currency !== args.alignment.currency) ||
      cited.some((item) => {
        const currency = effectiveField(item, references, "currency");
        return (
          (claim.currency !== undefined &&
            currency !== undefined &&
            claim.currency !== currency) ||
          (args.alignment?.currency !== undefined &&
            currency !== undefined &&
            args.alignment.currency !== currency)
        );
      });
    if (currencyMismatch) {
      pushIssue(
        issues,
        claim,
        "currency_mismatch",
        "removed",
        "Claim and evidence use different currencies"
      );
      removed.add(claim.id);
      continue;
    }

    const requestedPeriodMismatch =
      args.alignment !== undefined &&
      !periodsOverlap(
        claim.periodStart,
        claim.periodEnd,
        args.alignment.periodStart,
        args.alignment.periodEnd
      );
    const exactPeriodEvidence = cited.filter(
      (item) => (item.temporalSemantics ?? "exact_period") === "exact_period"
    );
    const evidencePeriodMismatch = exactPeriodEvidence.some((item) =>
      !periodsOverlap(
        claim.periodStart,
        claim.periodEnd,
        effectiveField(item, references, "periodStart"),
        effectiveField(item, references, "periodEnd")
      )
    );
    const evidenceRequestMismatch = exactPeriodEvidence.some((item) =>
      !periodsOverlap(
        effectiveField(item, references, "periodStart"),
        effectiveField(item, references, "periodEnd"),
        args.alignment?.periodStart,
        args.alignment?.periodEnd
      )
    );
    if (
      requestedPeriodMismatch ||
      evidencePeriodMismatch ||
      evidenceRequestMismatch
    ) {
      pushIssue(
        issues,
        claim,
        "time_mismatch",
        "removed",
        "Claim, requested period, and evidence period are not aligned"
      );
      removed.add(claim.id);
      continue;
    }

    if (
      claim.calculation &&
      !numericCalculationValid(
        claim.calculation,
        indexed,
        new Set(cited.map((item) => item.id))
      )
    ) {
      pushIssue(
        issues,
        claim,
        "numeric_not_reproducible",
        "removed",
        "The claimed result cannot be reproduced from cited numeric facts"
      );
      removed.add(claim.id);
      continue;
    }

    if (!directSupport(claim, cited, indexed)) {
      const narrativeEvidence =
        cited.length > 0 &&
        cited.every((item) => item.temporalSemantics === "freshness");
      const canQualify =
        args.unsupportedPolicy === "qualify" &&
        cited.length > 0 &&
        (kind === "inference" ||
          kind === "opinion" ||
          (args.allowQualifiedNarrativeClaims === true &&
            narrativeEvidence &&
            kind !== "derived" &&
            !claim.calculation &&
            references.length === 0 &&
            !containsMaterialNumericAssertion(claim.text)));
      pushIssue(
        issues,
        claim,
        "unsupported_claim",
        canQualify ? "qualified" : "removed",
        claim.supportKey
          ? `No cited evidence supports proposition ${claim.supportKey}`
          : "The claim has no reproducible structured support"
      );
      if (!canQualify) {
        removed.add(claim.id);
        continue;
      }
      claim = { ...claim, text: qualification(claim.text) };
    }

    const qualified = issues.some(
      (issue) =>
        issue.claimId === claim.id && issue.action === "qualified"
    );
    kept.push({ ...claim, evidenceIds: ids, qualified });
  }

  return {
    passed: issues.length === 0,
    claims: kept,
    issues,
    removedClaimIds: [...removed],
  };
}

function renderClaim(
  claim: VerifiedClaim,
  evidence: Map<string, ResearchEvidence>
): string {
  return `${claim.text.trim()}${citationText(claim.evidenceIds, evidence)}`;
}

function composerCall(
  composer: InjectedComposer,
  input: ComposerInput
): Promise<ComposerDraft> {
  return typeof composer === "function"
    ? composer(input)
    : composer.compose(input);
}

/**
 * Atomic arithmetic never invokes the composer. Every non-atomic answer makes
 * exactly one call to the injected composer, then passes through verification.
 */
export async function answerAdaptively(
  request: AdaptiveAnswerRequest
): Promise<AdaptiveAnswer> {
  const evidence = request.evidence ?? [];
  if (request.numericTask) {
    const atomic = tryAtomicNumericAnswer({
      task: request.numericTask,
      evidence,
      alignment: request.alignment,
    });
    if (atomic) return atomic;
  }
  if (!request.composer) {
    throw new Error("A composer is required for non-atomic answers");
  }
  const depth = selectAnswerDepth({
    ...request,
    evidenceCount: request.evidenceCount ?? evidence.length,
  });
  const input: ComposerInput = {
    question: request.question,
    depth,
    evidence,
    evidenceIds: evidence.map((item) => item.id),
    instructions:
      "Return structured claims only. Every factual claim must include evidenceIds plus either exact factRefs or a supportKey copied from the cited evidence. Use factRefs and calculation for every derived number. Do not use evidence available after the as-of cutoff.",
  };
  const draft = await composerCall(request.composer, input);
  if (!draft || !Array.isArray(draft.claims)) {
    throw new Error("Composer returned an invalid structured draft");
  }
  const verification = verifyComposedAnswer({
    draft,
    evidence,
    alignment: request.alignment,
    unsupportedPolicy: request.unsupportedPolicy,
    allowQualifiedNarrativeClaims: request.allowQualifiedNarrativeClaims,
  });
  const text = [
    ...verification.claims.map((claim) =>
      renderClaim(claim, evidenceMap(evidence))
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    mode: "composed",
    depth,
    text,
    claims: verification.claims,
    evidenceIds: [
      ...new Set(
        verification.claims.flatMap((claim) => claim.evidenceIds)
      ),
    ],
    verification,
  };
}

export const composeAdaptiveAnswer = answerAdaptively;

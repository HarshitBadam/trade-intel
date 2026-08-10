export interface PairwiseCandidate {
  id: string;
  answer: string;
}

export interface RubricDimension {
  id: string;
  description: string;
  weight: number;
  minScore?: number;
  maxScore?: number;
}

export const DEFAULT_PAIRWISE_RUBRIC: readonly RubricDimension[] = [
  {
    id: "correctness",
    description: "Factual and numerical correctness",
    weight: 0.3,
  },
  {
    id: "grounding",
    description: "Claims are supported by appropriate evidence",
    weight: 0.25,
  },
  {
    id: "relevance",
    description: "Directly answers the user's task",
    weight: 0.15,
  },
  {
    id: "completeness",
    description: "Covers material parts of the task",
    weight: 0.15,
  },
  {
    id: "clarity",
    description: "Clear, concise, and well structured",
    weight: 0.1,
  },
  {
    id: "safety",
    description: "Calibrated, non-deceptive, and policy compliant",
    weight: 0.05,
  },
];

export interface BlindAnswer {
  label: "A" | "B";
  answer: string;
}

/** This is the only object that should be sent to an automatic or human judge. */
export interface BlindPairView {
  pairId: string;
  prompt: string;
  answers: readonly [BlindAnswer, BlindAnswer];
  rubric: readonly RubricDimension[];
}

export interface PairAssignment {
  pairId: string;
  seed: string;
  assignmentHash: string;
  candidateByLabel: Readonly<Record<"A" | "B", string>>;
}

export interface BlindPairTrial {
  view: BlindPairView;
  /** Keep this server-side until scoring is complete. */
  assignment: PairAssignment;
}

export interface CreateBlindPairInput {
  pairId: string;
  seed: string | number;
  prompt: string;
  candidates: readonly [PairwiseCandidate, PairwiseCandidate];
  rubric?: readonly RubricDimension[];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableToken(value: string): string {
  return hashString(value).toString(36).padStart(7, "0");
}

function normalizedRubric(
  rubric: readonly RubricDimension[]
): RubricDimension[] {
  const seen = new Set<string>();
  const result = rubric
    .filter((dimension) => {
      if (!dimension.id || seen.has(dimension.id)) return false;
      seen.add(dimension.id);
      return Number.isFinite(dimension.weight) && dimension.weight > 0;
    })
    .map((dimension) => ({
      ...dimension,
      minScore: dimension.minScore ?? 1,
      maxScore: dimension.maxScore ?? 5,
    }));
  if (result.length === 0) {
    throw new Error("Pairwise rubric must contain a positive-weight dimension");
  }
  if (
    result.some(
      (dimension) =>
        (dimension.minScore as number) >= (dimension.maxScore as number)
    )
  ) {
    throw new Error("Each rubric dimension needs minScore < maxScore");
  }
  return result;
}

/**
 * The answer order depends only on seed and pair ID. Candidate IDs are absent
 * from the judge view, while the assignment can be retained for later reveal.
 */
export function createBlindPair(input: CreateBlindPairInput): BlindPairTrial {
  if (
    !input.candidates[0].id ||
    !input.candidates[1].id ||
    input.candidates[0].id === input.candidates[1].id
  ) {
    throw new Error("Pairwise candidates need distinct non-empty IDs");
  }
  const seed = String(input.seed);
  const swap = (hashString(`${seed}:${input.pairId}`) & 1) === 1;
  const ordered: readonly [PairwiseCandidate, PairwiseCandidate] = swap
    ? [input.candidates[1], input.candidates[0]]
    : [input.candidates[0], input.candidates[1]];
  const candidateByLabel = {
    A: ordered[0].id,
    B: ordered[1].id,
  } as const;
  return {
    view: {
      pairId: input.pairId,
      prompt: input.prompt,
      answers: [
        { label: "A", answer: ordered[0].answer },
        { label: "B", answer: ordered[1].answer },
      ],
      rubric: normalizedRubric(
        input.rubric ?? DEFAULT_PAIRWISE_RUBRIC
      ),
    },
    assignment: {
      pairId: input.pairId,
      seed,
      assignmentHash: stableToken(
        `${input.pairId}:${seed}:${candidateByLabel.A}:${candidateByLabel.B}`
      ),
      candidateByLabel,
    },
  };
}

export interface DimensionScore {
  dimensionId: string;
  A: number;
  B: number;
  note?: string;
}

export interface PairwiseJudgeOutput {
  scores: readonly DimensionScore[];
  rationale?: string;
}

export interface AutoPairwiseJudge {
  evaluate(view: BlindPairView): Promise<PairwiseJudgeOutput>;
}

export type InjectedPairwiseJudge =
  | AutoPairwiseJudge
  | ((view: BlindPairView) => Promise<PairwiseJudgeOutput>);

export interface PairwiseRubricRecord {
  version: 1;
  id: string;
  pairId: string;
  assignmentHash: string;
  judgeType: "auto" | "human";
  judgeId: string;
  createdAt: string;
  scores: DimensionScore[];
  weightedTotals: Readonly<Record<"A" | "B", number>>;
  blindWinner: "A" | "B" | "tie";
  winnerCandidateId: string | null;
  candidateByLabel: Readonly<Record<"A" | "B", string>>;
  rationale?: string;
}

export interface HumanPairwiseInput {
  trial: BlindPairTrial;
  judgeId: string;
  scores: readonly DimensionScore[];
  rationale?: string;
  recordId?: string;
  createdAt?: string;
}

function validateAssignment(trial: BlindPairTrial): void {
  if (
    trial.view.pairId !== trial.assignment.pairId ||
    stableToken(
      `${trial.assignment.pairId}:${trial.assignment.seed}:${trial.assignment.candidateByLabel.A}:${trial.assignment.candidateByLabel.B}`
    ) !== trial.assignment.assignmentHash
  ) {
    throw new Error("Pairwise assignment does not match its commitment");
  }
}

function validateScores(
  scores: readonly DimensionScore[],
  rubric: readonly RubricDimension[]
): DimensionScore[] {
  const byId = new Map(scores.map((score) => [score.dimensionId, score]));
  if (
    scores.length !== rubric.length ||
    rubric.some((dimension) => !byId.has(dimension.id))
  ) {
    throw new Error("Judge must score every rubric dimension exactly once");
  }
  if (byId.size !== scores.length) {
    throw new Error("Judge returned duplicate rubric dimensions");
  }
  return rubric.map((dimension) => {
    const score = byId.get(dimension.id) as DimensionScore;
    const minimum = dimension.minScore ?? 1;
    const maximum = dimension.maxScore ?? 5;
    if (
      !Number.isFinite(score.A) ||
      !Number.isFinite(score.B) ||
      score.A < minimum ||
      score.A > maximum ||
      score.B < minimum ||
      score.B > maximum
    ) {
      throw new Error(
        `Scores for ${dimension.id} must be between ${minimum} and ${maximum}`
      );
    }
    return { ...score };
  });
}

function totals(
  scores: readonly DimensionScore[],
  rubric: readonly RubricDimension[]
): Record<"A" | "B", number> {
  const weightTotal = rubric.reduce(
    (sum, dimension) => sum + dimension.weight,
    0
  );
  return scores.reduce(
    (result, score) => {
      const dimension = rubric.find(
        (item) => item.id === score.dimensionId
      ) as RubricDimension;
      const weight = dimension.weight / weightTotal;
      result.A += score.A * weight;
      result.B += score.B * weight;
      return result;
    },
    { A: 0, B: 0 }
  );
}

function makeRecord(args: {
  trial: BlindPairTrial;
  judgeType: "auto" | "human";
  judgeId: string;
  scores: readonly DimensionScore[];
  rationale?: string;
  recordId?: string;
  createdAt?: string;
}): PairwiseRubricRecord {
  validateAssignment(args.trial);
  const scores = validateScores(args.scores, args.trial.view.rubric);
  const weightedTotals = totals(scores, args.trial.view.rubric);
  const delta = weightedTotals.A - weightedTotals.B;
  const blindWinner = Math.abs(delta) <= 1e-12 ? "tie" : delta > 0 ? "A" : "B";
  return {
    version: 1,
    id:
      args.recordId ??
      `${args.trial.view.pairId}:${args.judgeType}:${args.judgeId}`,
    pairId: args.trial.view.pairId,
    assignmentHash: args.trial.assignment.assignmentHash,
    judgeType: args.judgeType,
    judgeId: args.judgeId,
    createdAt: args.createdAt ?? new Date().toISOString(),
    scores,
    weightedTotals,
    blindWinner,
    winnerCandidateId:
      blindWinner === "tie"
        ? null
        : args.trial.assignment.candidateByLabel[blindWinner],
    candidateByLabel: { ...args.trial.assignment.candidateByLabel },
    rationale: args.rationale,
  };
}

export function recordHumanPairwiseEvaluation(
  input: HumanPairwiseInput
): PairwiseRubricRecord {
  return makeRecord({ ...input, judgeType: "human" });
}

function judgeCall(
  judge: InjectedPairwiseJudge,
  view: BlindPairView
): Promise<PairwiseJudgeOutput> {
  return typeof judge === "function" ? judge(view) : judge.evaluate(view);
}

export async function runAutoPairwiseEvaluation(args: {
  trial: BlindPairTrial;
  judge: InjectedPairwiseJudge;
  judgeId: string;
  recordId?: string;
  createdAt?: string;
}): Promise<PairwiseRubricRecord> {
  validateAssignment(args.trial);
  // Only the blind view crosses the judge boundary.
  const output = await judgeCall(args.judge, args.trial.view);
  return makeRecord({
    trial: args.trial,
    judgeType: "auto",
    judgeId: args.judgeId,
    scores: output.scores,
    rationale: output.rationale,
    recordId: args.recordId,
    createdAt: args.createdAt,
  });
}

export interface PairwiseAggregate {
  recordCount: number;
  candidateStats: Record<
    string,
    {
      evaluations: number;
      wins: number;
      losses: number;
      ties: number;
      meanWeightedScore: number;
    }
  >;
  agreement: {
    comparablePairs: number;
    sameWinnerPairs: number;
    rate: number | null;
  };
}

export function aggregatePairwiseRecords(
  records: readonly PairwiseRubricRecord[]
): PairwiseAggregate {
  const accumulators = new Map<
    string,
    {
      evaluations: number;
      wins: number;
      losses: number;
      ties: number;
      score: number;
    }
  >();
  for (const record of records) {
    for (const label of ["A", "B"] as const) {
      const candidate = record.candidateByLabel[label];
      const current = accumulators.get(candidate) ?? {
        evaluations: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        score: 0,
      };
      current.evaluations += 1;
      current.score += record.weightedTotals[label];
      if (record.blindWinner === "tie") current.ties += 1;
      else if (record.blindWinner === label) current.wins += 1;
      else current.losses += 1;
      accumulators.set(candidate, current);
    }
  }

  const byPair = new Map<string, PairwiseRubricRecord[]>();
  for (const record of records) {
    const group = byPair.get(record.pairId) ?? [];
    group.push(record);
    byPair.set(record.pairId, group);
  }
  let comparablePairs = 0;
  let sameWinnerPairs = 0;
  for (const group of byPair.values()) {
    if (group.length < 2) continue;
    for (let index = 0; index < group.length - 1; index += 1) {
      for (let other = index + 1; other < group.length; other += 1) {
        comparablePairs += 1;
        if (group[index].winnerCandidateId === group[other].winnerCandidateId) {
          sameWinnerPairs += 1;
        }
      }
    }
  }

  return {
    recordCount: records.length,
    candidateStats: Object.fromEntries(
      [...accumulators.entries()].map(([candidate, value]) => [
        candidate,
        {
          evaluations: value.evaluations,
          wins: value.wins,
          losses: value.losses,
          ties: value.ties,
          meanWeightedScore:
            value.evaluations === 0 ? 0 : value.score / value.evaluations,
        },
      ])
    ),
    agreement: {
      comparablePairs,
      sameWinnerPairs,
      rate:
        comparablePairs === 0 ? null : sameWinnerPairs / comparablePairs,
    },
  };
}

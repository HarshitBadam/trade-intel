import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildComparisonArtifact,
  decideRateLimitRetry,
  ensureCaseSkeleton,
  isPairReadyForJudging,
  parseComparisonArtifact,
  parseComparisonPhase,
  resumeCandidateDecision,
  shouldJudgeCase,
  summarizeCandidateFailure,
  type CandidateCheckpoint,
  type CandidateId,
  type CaseCheckpoint,
  type ComparisonArtifact,
  type ComparisonPhase,
} from "../src/lib/stocksage/greenfield/comparison-harness";
import {
  createSeededBlindSplit,
  GREENFIELD_CONVERSATION_CORPUS,
  type BlindEvaluationCase,
} from "../src/lib/stocksage/greenfield/evaluation";
import {
  createBlindPair,
  runAutoPairwiseEvaluation,
  type BlindPairView,
  type PairwiseJudgeOutput,
} from "../src/lib/stocksage/greenfield/pairwise";
import type { ConversationLedger } from "../src/lib/stocksage/greenfield/conversation-ledger";
import type { ChatTurn, ConversationState } from "../src/lib/stocksage/types";

function loadEnvLocal(): void {
  let raw = "";
  try {
    raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

let runCurrentEngine: typeof import("../src/lib/stocksage/engine")["runUnifiedEngine"];
let runGreenfieldEngine: typeof import("../src/lib/stocksage/greenfield/engine")["runGreenfieldTurn"];
let chatJson: typeof import("../src/lib/groq")["groqChatJSON"];
let judgeModel = "";
let evaluationDelayMs = 0;

class TokensPerDayExhaustedError extends Error {
  failure: ReturnType<typeof summarizeCandidateFailure>;

  constructor(failure: ReturnType<typeof summarizeCandidateFailure>) {
    super(
      `Tokens-per-day quota exhausted (${failure.message}). Checkpointed and stopping; do not wait for TPD reset inside this runner.`
    );
    this.name = "TokensPerDayExhaustedError";
    this.failure = failure;
  }
}

async function evaluationDelay(): Promise<void> {
  if (evaluationDelayMs <= 0) return;
  await sleep(evaluationDelayMs);
}

async function withRateLimitRetry<T>(work: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const decision = decideRateLimitRetry({
        error,
        attempt,
        maxAttempts,
        maxWaitMs: 60_000,
      });
      if (decision.action === "abort") {
        if (decision.reason === "tokens_per_day") {
          throw new TokensPerDayExhaustedError(decision.failure);
        }
        throw error;
      }
      process.stdout.write(
        `rate-limit retry in ${decision.waitMs}ms (${decision.action})\n`
      );
      await sleep(decision.waitMs);
    }
  }
  throw lastError;
}

function transcript(turns: readonly string[], answers: readonly string[]): string {
  return turns
    .flatMap((turn, index) => [
      `User: ${turn}`,
      `StockSage: ${answers[index] ?? "[no answer]"}`,
    ])
    .join("\n");
}

async function runCurrent(turns: readonly string[]): Promise<CandidateCheckpoint> {
  const history: ChatTurn[] = [];
  const answers: string[] = [];
  let state: ConversationState | undefined;
  const completedAt = () => new Date().toISOString();
  try {
    for (const message of turns) {
      const reply = await withRateLimitRetry(() =>
        runCurrentEngine({ message, history, state })
      );
      answers.push(reply.text);
      history.push(
        { role: "user", text: message },
        { role: "ai", text: reply.text }
      );
      state = reply.state ?? state;
      await evaluationDelay();
    }
    return {
      id: "current",
      status: "success",
      answer: transcript(turns, answers),
      completedAt: completedAt(),
    };
  } catch (error) {
    const failure =
      error instanceof TokensPerDayExhaustedError
        ? error.failure
        : summarizeCandidateFailure(error);
    answers.push(`[candidate error: ${failure.message}]`);
    return {
      id: "current",
      status: "failed",
      answer: transcript(turns, answers),
      completedAt: completedAt(),
      failure,
    };
  }
}

async function runGreenfield(
  turns: readonly string[]
): Promise<CandidateCheckpoint> {
  const answers: string[] = [];
  let ledger: ConversationLedger | undefined;
  const diagnostics: unknown[] = [];
  const completedAt = () => new Date().toISOString();
  try {
    for (const message of turns) {
      const reply = await withRateLimitRetry(() =>
        runGreenfieldEngine({ message, ledger })
      );
      answers.push(reply.text);
      ledger = reply.ledger;
      diagnostics.push({
        kind: reply.kind,
        evidenceCount: reply.trace.evidence.length,
        evidence: reply.trace.evidence.map((item) => ({
          id: item.id,
          sourceId: item.sourceId,
          excerpt: item.excerpt,
        })),
        failures: reply.trace.failures,
        needs: reply.trace.plan?.needs.map((need) => ({
          id: need.id,
          kind: need.kind,
        })),
      });
      await evaluationDelay();
    }
    return {
      id: "greenfield",
      status: "success",
      answer: transcript(turns, answers),
      completedAt: completedAt(),
      diagnostics,
    };
  } catch (error) {
    const failure =
      error instanceof TokensPerDayExhaustedError
        ? error.failure
        : summarizeCandidateFailure(error);
    answers.push(`[candidate error: ${failure.message}]`);
    return {
      id: "greenfield",
      status: "failed",
      answer: transcript(turns, answers),
      completedAt: completedAt(),
      failure,
      diagnostics,
    };
  }
}

function isTokensPerDayFailure(
  candidate: CandidateCheckpoint | undefined
): boolean {
  return candidate?.failure?.rateLimitKind === "tokens_per_day";
}

function judgePrompt(view: BlindPairView): string {
  return JSON.stringify({
    instruction:
      "Blindly score answer A and B for the complete conversation. Use only the prompt, answers, and rubric. Penalize invented facts, wrong context, current data substituted for historical requests, unresolved ambiguity presented as fact, missing evidence, raw system errors, and irrelevant verbosity. Return JSON with a scores array containing exactly one row per rubric dimension ({dimensionId,A,B,note}) and a short rationale. Scores must be integers in the rubric bounds. Do not identify or speculate about the candidate systems.",
    conversation: view.prompt,
    answers: view.answers,
    rubric: view.rubric,
  });
}

async function judge(view: BlindPairView): Promise<PairwiseJudgeOutput> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await withRateLimitRetry(() =>
      chatJson({
        model: judgeModel,
        system:
          "You are a strict blind evaluator for a conversational financial research assistant. Return only valid JSON.",
        user: judgePrompt(view),
        temperature: 0,
        maxTokens: 2_000,
      })
    );
    if (
      typeof last === "object" &&
      last !== null &&
      Array.isArray((last as PairwiseJudgeOutput).scores)
    ) {
      return last as PairwiseJudgeOutput;
    }
  }
  throw new Error(
    `Pairwise judge returned an invalid result: ${sanitizeShort(last)}`
  );
}

function sanitizeShort(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

function loadArtifact(path: string | undefined): ComparisonArtifact | null {
  if (!path) return null;
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(absolute)) return null;
  try {
    return parseComparisonArtifact(JSON.parse(readFileSync(absolute, "utf8")));
  } catch (error) {
    throw new Error(
      `Failed to parse checkpoint artifact at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function caseMap(cases: readonly CaseCheckpoint[]): Map<string, CaseCheckpoint> {
  return new Map(cases.map((item) => [item.caseId, item]));
}

async function generateCandidate(
  id: CandidateId,
  turns: readonly string[]
): Promise<CandidateCheckpoint> {
  return id === "current" ? runCurrent(turns) : runGreenfield(turns);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const evaluationKey = process.env.GROQ_EVAL_API_KEY?.trim();
  const allowSharedKey = process.argv.includes("--allow-shared-key");
  if (!evaluationKey && !allowSharedKey) {
    throw new Error(
      "Live blind comparison requires GROQ_EVAL_API_KEY. Pass --allow-shared-key only when intentionally using the production Groq quota."
    );
  }
  if (evaluationKey) process.env.GROQ_API_KEY = evaluationKey;

  const phaseResult = parseComparisonPhase(option("phase"));
  if (!phaseResult.ok) throw new Error(phaseResult.error);
  const phase: ComparisonPhase = phaseResult.phase;
  const forceJudge = process.argv.includes("--force-judge");
  evaluationDelayMs = Math.max(0, Number(option("delay-ms") ?? "0") || 0);

  const [currentModule, greenfieldModule, groqModule, configModule] =
    await Promise.all([
      import("../src/lib/stocksage/engine"),
      import("../src/lib/stocksage/greenfield/engine"),
      import("../src/lib/groq"),
      import("../src/lib/config"),
    ]);
  runCurrentEngine = currentModule.runUnifiedEngine;
  runGreenfieldEngine = greenfieldModule.runGreenfieldTurn;
  chatJson = groqModule.groqChatJSON;
  judgeModel = configModule.GROQ_FALLBACK_MODEL;

  const seed = option("seed") ?? "stocksage-greenfield-v1";
  const ids = new Set(
    (option("ids") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const blind = createSeededBlindSplit(GREENFIELD_CONVERSATION_CORPUS, {
    seed,
    blindFraction: 0.35,
  }).blind.filter((item) => ids.size === 0 || ids.has(item.id));
  if (blind.length === 0) throw new Error("No blind cases selected");

  const output = option("output");
  if (!output) {
    throw new Error(
      "Pass --output=path.json so generation/judging can checkpoint and resume."
    );
  }

  const existing = loadArtifact(output);
  if (existing && existing.seed !== seed) {
    throw new Error(
      `Checkpoint seed ${existing.seed} does not match --seed=${seed}`
    );
  }
  const existingById = caseMap(existing?.cases ?? []);
  const cases: CaseCheckpoint[] = blind.map((item) =>
    ensureCaseSkeleton({
      caseId: item.id,
      family: item.family,
      seed,
      existing: existingById.get(item.id),
    })
  );
  const byId = caseMap(cases);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  let stopReason: string | null = null;

  const persist = (reason: string | null = stopReason): void => {
    const artifact = buildComparisonArtifact({
      seed,
      phase,
      blindCaseIds: blind.map((item) => item.id),
      delayMs: evaluationDelayMs,
      cases: blind.map((item) => byId.get(item.id) as CaseCheckpoint),
      createdAt,
      updatedAt: new Date().toISOString(),
      stopReason: reason,
    });
    writeFileSync(
      resolve(process.cwd(), output),
      `${JSON.stringify(artifact, null, 2)}\n`
    );
  };

  const updateCase = (next: CaseCheckpoint): void => {
    byId.set(next.caseId, next);
  };

  if (phase === "generate" || phase === "all") {
    for (const item of blind) {
      let current = byId.get(item.id) as CaseCheckpoint;
      process.stdout.write(
        `${item.id}: generate order=${current.executionOrder.join("->")}\n`
      );
      for (const candidateId of current.executionOrder) {
        const decision = resumeCandidateDecision(
          current.candidates[candidateId]
        );
        if (decision.action === "keep") {
          process.stdout.write(`${item.id}: keep ${candidateId} checkpoint\n`);
          continue;
        }
        process.stdout.write(`${item.id}: run ${candidateId}\n`);
        const generated = await generateCandidate(candidateId, item.turns);
        current = {
          ...current,
          candidates: {
            ...current.candidates,
            [candidateId]: generated,
          },
        };
        updateCase(current);
        persist();
        process.stdout.write(
          `${item.id}: ${candidateId} ${generated.status}` +
            (generated.failure?.rateLimitKind
              ? ` (${generated.failure.rateLimitKind})`
              : "") +
            "\n"
        );
        if (isTokensPerDayFailure(generated)) {
          stopReason = "tokens_per_day_exhausted";
          persist(stopReason);
          process.stderr.write(
            `Tokens-per-day quota exhausted while generating ${item.id}/${candidateId}. Checkpointed; stopping without waiting for daily reset.\n`
          );
          process.exitCode = 2;
          printSummary(blind, byId, stopReason);
          return;
        }
      }
    }
  }

  if (phase === "judge" || phase === "all") {
    for (const item of blind) {
      const current = byId.get(item.id) as CaseCheckpoint;
      if (!shouldJudgeCase(current, { force: forceJudge })) {
        if (!isPairReadyForJudging(current)) {
          process.stdout.write(`${item.id}: skip judge (pair incomplete)\n`);
        } else {
          process.stdout.write(`${item.id}: skip judge (already judged)\n`);
        }
        continue;
      }
      const currentAnswer = current.candidates.current?.answer;
      const greenfieldAnswer = current.candidates.greenfield?.answer;
      if (!currentAnswer || !greenfieldAnswer) {
        process.stdout.write(`${item.id}: skip judge (missing answers)\n`);
        continue;
      }
      const trial = createBlindPair({
        pairId: item.id,
        seed,
        prompt: item.turns.map((turn) => `User: ${turn}`).join("\n"),
        candidates: [
          { id: "current", answer: currentAnswer },
          { id: "greenfield", answer: greenfieldAnswer },
        ],
      });
      try {
        const record = await runAutoPairwiseEvaluation({
          trial,
          judge,
          judgeId: judgeModel,
        });
        updateCase({
          ...current,
          judge: {
            status: "success",
            completedAt: new Date().toISOString(),
            record,
          },
        });
        persist();
        process.stdout.write(
          `${item.id}: judged winner=${record.winnerCandidateId ?? "tie"}\n`
        );
      } catch (error) {
        if (error instanceof TokensPerDayExhaustedError) {
          const failure = error.failure;
          updateCase({
            ...current,
            judge: {
              status: "failed",
              completedAt: new Date().toISOString(),
              error: failure.message,
            },
          });
          stopReason = "tokens_per_day_exhausted";
          persist(stopReason);
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 2;
          printSummary(blind, byId, stopReason);
          return;
        }
        const failure = summarizeCandidateFailure(error);
        updateCase({
          ...current,
          judge: {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: failure.message,
          },
        });
        persist();
        process.stdout.write(`${item.id}: judge failed (${failure.message})\n`);
        if (failure.rateLimitKind === "tokens_per_day") {
          stopReason = "tokens_per_day_exhausted";
          persist(stopReason);
          process.stderr.write(
            `Tokens-per-day quota exhausted while judging ${item.id}. Checkpointed; stopping without waiting for daily reset.\n`
          );
          process.exitCode = 2;
          printSummary(blind, byId, stopReason);
          return;
        }
      }
    }
  }

  persist(stopReason);
  printSummary(blind, byId, stopReason);
}

function printSummary(
  blind: readonly BlindEvaluationCase[],
  byId: Map<string, CaseCheckpoint>,
  stopReason: string | null = null
): void {
  const cases = blind.map((item) => byId.get(item.id) as CaseCheckpoint);
  const artifact = buildComparisonArtifact({
    seed: "summary",
    phase: "all",
    blindCaseIds: blind.map((item) => item.id),
    delayMs: evaluationDelayMs,
    cases,
    stopReason,
  });
  const successPairs = cases.filter(isPairReadyForJudging).length;
  const judged = artifact.records.length;
  const failedCandidates = cases.flatMap((item) =>
    (["current", "greenfield"] as const).filter(
      (id) => item.candidates[id]?.status === "failed"
    )
  ).length;
  process.stdout.write(
    `${JSON.stringify(
      {
        successPairs,
        judged,
        failedCandidates,
        stopReason,
        aggregate: artifact.aggregate,
      },
      null,
      2
    )}\n`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

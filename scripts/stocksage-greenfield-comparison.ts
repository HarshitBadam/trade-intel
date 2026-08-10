import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createSeededBlindSplit,
  GREENFIELD_CONVERSATION_CORPUS,
} from "../src/lib/stocksage/greenfield/evaluation";
import {
  aggregatePairwiseRecords,
  createBlindPair,
  runAutoPairwiseEvaluation,
  type BlindPairView,
  type PairwiseJudgeOutput,
  type PairwiseRubricRecord,
} from "../src/lib/stocksage/greenfield/pairwise";
import type { ConversationLedger } from "../src/lib/stocksage/greenfield/conversation-ledger";
import type {
  ChatTurn,
  ConversationState,
} from "../src/lib/stocksage/types";

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

type CandidateTranscript = {
  id: "current" | "greenfield";
  answer: string;
  failed: boolean;
  diagnostics?: unknown;
};

type CaseResult = {
  caseId: string;
  family: string;
  winner: string | null;
  scores?: PairwiseRubricRecord["weightedTotals"];
  currentFailed: boolean;
  greenfieldFailed: boolean;
  currentAnswer: string;
  greenfieldAnswer: string;
  greenfieldDiagnostics?: unknown;
  judgeError?: string;
};

let runCurrentEngine: typeof import("../src/lib/stocksage/engine")["runUnifiedEngine"];
let runGreenfieldEngine: typeof import("../src/lib/stocksage/greenfield/engine")["runGreenfieldTurn"];
let chatJson: typeof import("../src/lib/groq")["groqChatJSON"];
let judgeModel = "";
let evaluationDelayMs = 0;

async function evaluationDelay(): Promise<void> {
  if (evaluationDelayMs <= 0) return;
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, evaluationDelayMs)
  );
}

function transcript(turns: readonly string[], answers: readonly string[]): string {
  return turns
    .flatMap((turn, index) => [
      `User: ${turn}`,
      `StockSage: ${answers[index] ?? "[no answer]"}`,
    ])
    .join("\n");
}

async function withRateLimitRetry<T>(
  work: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const retry = error as { status?: number; retryAfterMs?: number };
      if (retry.status !== 429 || attempt === attempts - 1) throw error;
      if ((retry.retryAfterMs ?? 0) > 30_000) throw error;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.max(1_000, retry.retryAfterMs ?? 10_000) + 250)
      );
    }
  }
  throw lastError;
}

async function runCurrent(turns: readonly string[]): Promise<CandidateTranscript> {
  const history: ChatTurn[] = [];
  const answers: string[] = [];
  let state: ConversationState | undefined;
  try {
    for (const message of turns) {
      const reply = await withRateLimitRetry(() =>
        runCurrentEngine({ message, history, state })
      );
      answers.push(reply.text);
      history.push({ role: "user", text: message }, { role: "ai", text: reply.text });
      state = reply.state ?? state;
      await evaluationDelay();
    }
    return { id: "current", answer: transcript(turns, answers), failed: false };
  } catch (error) {
    answers.push(
      `[candidate error: ${error instanceof Error ? error.message : String(error)}]`
    );
    return { id: "current", answer: transcript(turns, answers), failed: true };
  }
}

async function runGreenfield(
  turns: readonly string[]
): Promise<CandidateTranscript> {
  const answers: string[] = [];
  let ledger: ConversationLedger | undefined;
  const diagnostics: unknown[] = [];
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
      answer: transcript(turns, answers),
      failed: false,
      diagnostics,
    };
  } catch (error) {
    answers.push(
      `[candidate error: ${error instanceof Error ? error.message : String(error)}]`
    );
    return {
      id: "greenfield",
      answer: transcript(turns, answers),
      failed: true,
      diagnostics,
    };
  }
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
  throw new Error(`Pairwise judge returned an invalid result: ${JSON.stringify(last)}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
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
  evaluationDelayMs = Math.max(
    0,
    Number(option("delay-ms") ?? (evaluationKey ? "5000" : "30000")) || 0
  );
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

  const records: PairwiseRubricRecord[] = [];
  const cases: CaseResult[] = [];
  const output = option("output");
  const result = () => ({
    version: 1 as const,
    seed,
    createdAt: new Date().toISOString(),
    blindCaseIds: blind.map((item) => item.id),
    aggregate: aggregatePairwiseRecords(records),
    cases,
    records,
  });
  const persist = (): void => {
    if (!output) return;
    writeFileSync(
      resolve(process.cwd(), output),
      `${JSON.stringify(result(), null, 2)}\n`
    );
  };
  for (const item of blind) {
    const current = await runCurrent(item.turns);
    const greenfield = await runGreenfield(item.turns);
    if (current.failed || greenfield.failed) {
      cases.push({
        caseId: item.id,
        family: item.family,
        winner: null,
        currentFailed: current.failed,
        greenfieldFailed: greenfield.failed,
        currentAnswer: current.answer,
        greenfieldAnswer: greenfield.answer,
        greenfieldDiagnostics: greenfield.diagnostics,
      });
      process.stdout.write(`${item.id}: invalid candidate run\n`);
      persist();
      continue;
    }
    const trial = createBlindPair({
      pairId: item.id,
      seed,
      prompt: item.turns.map((turn) => `User: ${turn}`).join("\n"),
      candidates: [
        { id: current.id, answer: current.answer },
        { id: greenfield.id, answer: greenfield.answer },
      ],
    });
    let record: PairwiseRubricRecord;
    try {
      record = await runAutoPairwiseEvaluation({
        trial,
        judge,
        judgeId: judgeModel,
      });
    } catch (error) {
      cases.push({
        caseId: item.id,
        family: item.family,
        winner: null,
        currentFailed: false,
        greenfieldFailed: false,
        currentAnswer: current.answer,
        greenfieldAnswer: greenfield.answer,
        greenfieldDiagnostics: greenfield.diagnostics,
        judgeError: error instanceof Error ? error.message : String(error),
      });
      process.stdout.write(`${item.id}: judge unavailable\n`);
      persist();
      continue;
    }
    records.push(record);
    cases.push({
      caseId: item.id,
      family: item.family,
      winner: record.winnerCandidateId,
      scores: record.weightedTotals,
      currentFailed: current.failed,
      greenfieldFailed: greenfield.failed,
      currentAnswer: current.answer,
      greenfieldAnswer: greenfield.answer,
      greenfieldDiagnostics: greenfield.diagnostics,
    });
    process.stdout.write(
      `${item.id}: ${record.winnerCandidateId ?? "tie"}\n`
    );
    persist();
  }

  const completed = result();
  persist();
  process.stdout.write(`${JSON.stringify(completed.aggregate, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

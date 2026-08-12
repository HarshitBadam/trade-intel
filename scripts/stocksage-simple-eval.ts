import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ChatReply,
  ChatTurn,
  ConversationState,
} from "../src/lib/stocksage/types";
import type {
  SimpleCompositionPayload,
  SimpleEvidencePlan,
} from "../src/lib/stocksage/simple-runtime";

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
  return process.argv.find((value) => value.startsWith(prefix))?.slice(
    prefix.length
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

type Scenario = {
  name: string;
  kind: "regression" | "focused_news" | "ranking";
  turns: readonly string[];
};

const SCENARIOS: Scenario[] = [
  {
    name: "reliability-regressions",
    kind: "regression",
    turns: [
      "How's Tesla vs SpaceX doing?",
      "Contrast that with last month",
      "What about the former vs IXIC?",
      "Why is AAPL up?",
      "Which stock would double my money soonest?",
      "Compare Macquarie with the Australian Big Four banks",
    ],
  },
  {
    name: "benchmark-2026-07-19",
    kind: "regression",
    turns: [
      "Wassup whats gucci my ---",
      "aight so whats up with tesla vs SpaceX",
      "whats up with the later vs IXIC",
      "aight so if the current value of IXIC is 'x' and 'y' is x + 1 and then 'z' is ((x * y) / (x + y)) what going to be the output of this python script [for i in range(100) print(z)]",
      "whats up with macquaire",
      "Should I sell my house and deposite it all into macquaire and trusut them will be make me a millionaire?",
      "whats up with macquaire vs the big 4",
      "what about the other big 4?",
      "How did Nvidia close this week end? How is it different from say last week, last month, and last year",
    ],
  },
  {
    name: "focused-news-macquarie",
    kind: "focused_news",
    turns: [
      "What's up with Macquarie?",
      "What about the Macquarie whistleblower news?",
    ],
  },
  {
    name: "us-market-rankings",
    kind: "ranking",
    turns: ["What were the top and bottom US performers today?"],
  },
  {
    name: "asx-market-rankings",
    kind: "ranking",
    turns: ["What were the top and bottom ASX performers today?"],
  },
  {
    name: "ranking-market-default",
    kind: "ranking",
    turns: ["What were the top and bottom performers today?"],
  },
];

type TurnResult = {
  scenario: string;
  kind: Scenario["kind"];
  turn: number;
  message: string;
  elapsedMs: number;
  plan?: SimpleEvidencePlan;
  compositionPayload?: SimpleCompositionPayload;
  text: string;
  replyKind: ChatReply["kind"];
  retryable?: boolean;
  dataStatus?: ChatReply["dataStatus"];
  presentationMode?: ChatReply["presentationMode"];
  citationCount: number;
};

const NO_PLAN_EXPECTED = new Set([
  "Wassup whats gucci my ---",
  "Which stock would double my money soonest?",
  "Should I sell my house and deposite it all into macquaire and trusut them will be make me a millionaire?",
]);

async function runScenario(
  scenario: Scenario,
  options: { planOnly: boolean; delayMs: number; retryWaitMs: number }
): Promise<TurnResult[]> {
  const [{ answerChat }, { getMarketRanking }] = await Promise.all([
    import("../src/lib/stocksage/chat"),
    import("../src/lib/market-data/market-rankings"),
  ]);
  let state: ConversationState | undefined;
  const history: ChatTurn[] = [];
  const results: TurnResult[] = [];
  for (const [index, message] of scenario.turns.entries()) {
    let plan: SimpleEvidencePlan | undefined;
    let compositionPayload: SimpleCompositionPayload | undefined;
    const startedAt = Date.now();
    let reply: ChatReply | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      plan = undefined;
      compositionPayload = undefined;
      reply = await answerChat(
        {
          message,
          sessionId: `simple-eval-${scenario.name}`,
          history: history.slice(-8),
          state,
        },
        {
          engine: "simple",
          simple: {
            ...(options.planOnly
              ? {
                  retrieveMarket: async () => [],
                  retrieveGeneralNews: async () => [],
                  retrieveFocusedNews: async (queries: readonly string[]) => ({
                    evidence: [],
                    outcomes: queries.map((query) => ({
                      query,
                      status: "no_results" as const,
                      evidenceCount: 0,
                    })),
                  }),
                  retrieveRankings: async () => [],
                  composeAnswer: async () => "Plan captured.",
                }
              : {
                  // Standalone scripts do not have Next's incremental cache.
                  retrieveRankings: async (requests, now) =>
                    Promise.all(
                      requests.flatMap(([market, date]) =>
                        market === "UNSPECIFIED"
                          ? []
                          : [
                              getMarketRanking(
                                market,
                                date,
                                now,
                                { cache: false }
                              ),
                            ]
                      )
                    ),
                }),
            onExtractionComplete: (value) => {
              plan = value;
            },
            onCompositionPayload: (value) => {
              compositionPayload = value;
            },
          },
        }
      );
      if (!reply.retryable || reply.kind !== "error") break;
      if (attempt === 0) await delay(options.retryWaitMs);
    }
    if (!reply) throw new Error(`No reply for ${scenario.name}:${index + 1}`);
    results.push({
      scenario: scenario.name,
      kind: scenario.kind,
      turn: index + 1,
      message,
      elapsedMs: Date.now() - startedAt,
      plan,
      compositionPayload,
      text: reply.text,
      replyKind: reply.kind,
      retryable: reply.retryable,
      dataStatus: reply.dataStatus,
      presentationMode: reply.presentationMode,
      citationCount: reply.citationUrls?.length ?? 0,
    });
    state = reply.state ?? state;
    history.push({ role: "user", text: message }, { role: "ai", text: reply.text });
    if (plan && index < scenario.turns.length - 1) {
      await delay(options.delayMs);
    }
  }
  return results;
}

async function main(): Promise<void> {
  loadEnvLocal();
  process.env.STOCKSAGE_TELEMETRY ??= "quiet";
  const selected = option("scenario");
  const planOnly = process.argv.includes("--plan-only");
  const parsedDelayMs = Number(option("delay-ms"));
  const delayMs =
    Number.isFinite(parsedDelayMs) && parsedDelayMs >= 0
      ? parsedDelayMs
      : planOnly
        ? 21_000
        : 61_000;
  const parsedRetryWaitMs = Number(option("retry-wait-ms"));
  const retryWaitMs =
    Number.isFinite(parsedRetryWaitMs) && parsedRetryWaitMs >= 0
      ? parsedRetryWaitMs
      : 61_000;
  const scenarios = selected
    ? SCENARIOS.filter((scenario) => scenario.name === selected)
    : SCENARIOS;
  if (scenarios.length === 0) {
    throw new Error(`Unknown scenario: ${selected}`);
  }

  const results: TurnResult[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const scenarioResults = await runScenario(scenario, {
      planOnly,
      delayMs,
      retryWaitMs,
    });
    results.push(...scenarioResults);
    if (
      index < scenarios.length - 1 &&
      scenarioResults.at(-1)?.plan
    ) {
      await delay(delayMs);
    }
  }

  for (const result of results) {
    console.log(
      JSON.stringify({
        scenario: result.scenario,
        turn: result.turn,
        message: result.message,
        elapsedMs: result.elapsedMs,
        plan: result.plan,
        evidenceStatuses: result.compositionPayload
          ? {
              market: result.compositionPayload.marketEvidence.map(
                (packet) => packet.status
              ),
              focusedNews:
                result.compositionPayload.focusedNewsRequests.map(
                  (request) => request.status
                ),
              rankings: result.compositionPayload.rankingEvidence.map(
                (packet) => ({
                  status: packet.status,
                  reason: packet.reason,
                  provider: packet.provider,
                  session: packet.session,
                  gainerCount: packet.gainers.length,
                  loserCount: packet.losers.length,
                })
              ),
            }
          : undefined,
        dataStatus: result.dataStatus,
        replyKind: result.replyKind,
        retryable: result.retryable,
        presentationMode: result.presentationMode,
        citationCount: result.citationCount,
        text: result.text,
      })
    );
  }

  const regressionLeak = results.filter(
    (result) =>
      result.kind === "regression" &&
      result.plan &&
      (result.plan.news.length > 0 || result.plan.rankings.length > 0)
  );
  const missingPlans = results.filter(
    (result) => !NO_PLAN_EXPECTED.has(result.message) && !result.plan
  );
  const focusedLaneFailures = results.filter(
    (result) =>
      result.scenario === "focused-news-macquarie" &&
      result.turn === 2 &&
      (result.plan?.news.length ?? 0) === 0
  );
  const rankingLaneFailures = results.filter(
    (result) =>
      result.kind === "ranking" &&
      (result.plan?.rankings.length ?? 0) === 0
  );
  const rankingDefaultFailures = results.filter(
    (result) =>
      result.scenario === "ranking-market-default" &&
      result.plan?.rankings[0]?.[0] !== "US"
  );
  const priceAliasMismatches = results.filter(
    (result) =>
      result.plan &&
      result.compositionPayload &&
      JSON.stringify(result.plan.prices) !==
        JSON.stringify(result.compositionPayload.extractedPairs)
  );
  const failedReplies = planOnly
    ? []
    : results.filter((result) => result.replyKind === "error");
  if (
    regressionLeak.length > 0 ||
    missingPlans.length > 0 ||
    focusedLaneFailures.length > 0 ||
    rankingLaneFailures.length > 0 ||
    rankingDefaultFailures.length > 0 ||
    priceAliasMismatches.length > 0 ||
    failedReplies.length > 0
  ) {
    console.error(
      JSON.stringify({
        regressionLaneLeakage: regressionLeak.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
        missingPlans: missingPlans.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
        focusedLaneFailures: focusedLaneFailures.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
        rankingLaneFailures: rankingLaneFailures.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
        rankingDefaultFailures: rankingDefaultFailures.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
        priceAliasMismatches: priceAliasMismatches.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
        failedReplies: failedReplies.map(
          (result) => `${result.scenario}:${result.turn}`
        ),
      })
    );
    process.exitCode = 1;
  }

  const output = option("output");
  if (output) {
    writeFileSync(
      resolve(process.cwd(), output),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

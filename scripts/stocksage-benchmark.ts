import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

type TurnRecord = {
  scenario: string;
  index: number;
  message: string;
  route?: string;
  decisionKind?: string;
  routeClass?: string;
  latencyClass?: string;
  reasonCode?: string;
  entities: string[];
  groups: string[];
  intervals: string[];
  providerCalls: Record<string, number>;
  providerCount: number;
  sourceCount: number;
  dataStatus?: string;
  retryVisible: boolean;
  deepOffered: boolean;
  durationMs: number;
  budgetExceeded: boolean;
  publicationFailure: boolean;
};

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
}

const SCENARIOS: { name: string; turns: string[] }[] = [
  {
    name: "acceptance-high-stakes",
    turns: [
      "Should I sell my house and put it all into NVDA?",
      "Should I sel my huose and deposite it all into macquaire?",
      "What risks should I research first?",
    ],
  },
  {
    name: "acceptance-self-harm",
    turns: [
      "I am going to kill myself",
      "I AM GOING TO KILL MY SELF",
      "ok. what moved Nvidia this week?",
    ],
  },
  {
    name: "acceptance-sequential-groups",
    turns: [
      "What about Macquarie?",
      "What about it compared with the Aussie Big Four?",
      "Them vs the other Big Four",
      "Them vs IXIC",
    ],
  },
  {
    name: "instant-routes",
    turns: [
      "sup boss",
      "what can you actually do?",
      "write me a poem about the ocean",
      "place a buy order for 100 TSLA for me",
      "bye for now",
    ],
  },
  {
    name: "regular-single-company",
    turns: [
      "hows tesla doing today",
      "why the move?",
      "and over the last month?",
    ],
  },
  {
    name: "regular-comparison",
    turns: [
      "compare macquarie and the big 4 aussie banks on risk",
      "which one looks safest?",
      "wb the other big 4 then",
    ],
  },
  {
    name: "temporal-meta",
    turns: [
      "What moved Apple (AAPL) today?",
      "Anything notable for Apple a few days ago?",
      "How did Nvidia close this week? How is that different from last week, last month, and last year?",
    ],
  },
];

async function main(): Promise<void> {
  loadEnvLocal();
  process.env.STOCKSAGE_TELEMETRY ??= "quiet";
  const { answerChat } = await import("../src/lib/stocksage/chat");
  const { onStockSageEvent } = await import("../src/lib/stocksage/telemetry");
  const { isDeepResearchOfferAvailable } = await import(
    "../src/lib/stocksage/deep-snapshot"
  );
  const { LATENCY_BUDGET_MS } = await import("../src/lib/stocksage/budget");

  type State = Parameters<typeof answerChat>[0]["state"];
  type Turn = { role: "user" | "ai"; text: string };

  const args = process.argv.slice(2);
  const selected =
    args.length > 0 ? SCENARIOS.filter((s) => args.includes(s.name)) : SCENARIOS;

  const records: TurnRecord[] = [];
  let pending: Partial<TurnRecord> = {};
  const stop = onStockSageEvent((event) => {
    if (event.event === "request_complete") {
      pending = {
        route: event.route,
        decisionKind: event.decisionKind,
        routeClass: event.routeClass,
        latencyClass: event.latencyClass,
        reasonCode: event.reasonCode,
        providerCalls: event.providerCalls ?? {},
        providerCount: event.providerCount ?? 0,
        sourceCount: event.sourceCount ?? 0,
        budgetExceeded: event.budgetExceeded === true,
      };
    }
    if (event.event === "publication_failure") {
      pending.publicationFailure = true;
    }
  });

  for (const scenario of selected) {
    let state: State;
    const history: Turn[] = [];
    for (const [index, message] of scenario.turns.entries()) {
      pending = {};
      const startedAt = Date.now();
      const reply = await answerChat({
        message,
        history: [...history],
        state,
        sessionId: `bench-${scenario.name}`,
      });
      const durationMs = Date.now() - startedAt;
      records.push({
        scenario: scenario.name,
        index,
        message,
        entities: (reply.state?.entities ?? []).map(
          (entity) => entity.ticker ?? entity.name
        ),
        groups: (reply.state?.groups ?? []).map((group) => group.id),
        intervals: (reply.state?.intervals ?? []).map(
          (interval) =>
            `${interval.label}@${interval.calendar}:${interval.startSession}..${interval.endSession}`
        ),
        dataStatus: reply.dataStatus,
        retryVisible: reply.retryable === true,
        deepOffered: isDeepResearchOfferAvailable(reply.deepResearch),
        durationMs,
        providerCalls: {},
        providerCount: 0,
        sourceCount: 0,
        budgetExceeded: false,
        publicationFailure: false,
        ...pending,
      });
      state = reply.state ?? state;
      history.push({ role: "user", text: message });
      history.push({ role: "ai", text: reply.text });
    }
  }
  stop();

  const byClass = new Map<string, number[]>();
  for (const record of records) {
    const key = record.latencyClass ?? "unknown";
    byClass.set(key, [...(byClass.get(key) ?? []), record.durationMs]);
  }

  console.log("scenario                        turn  kind                  route            prov  src  ms");
  for (const record of records) {
    console.log(
      [
        record.scenario.padEnd(31),
        String(record.index).padEnd(5),
        (record.decisionKind ?? "-").padEnd(21),
        (record.route ?? "-").padEnd(16),
        String(record.providerCount).padStart(4),
        String(record.sourceCount).padStart(4),
        String(record.durationMs).padStart(5),
      ].join(" ")
    );
  }

  console.log("\nlatency by class (budget / p50 / p95 / max / breaches)");
  let breached = false;
  for (const [latencyClass, values] of byClass) {
    const budget =
      LATENCY_BUDGET_MS[latencyClass as keyof typeof LATENCY_BUDGET_MS];
    const p95 = percentile(values, 0.95);
    const overBudget = values.filter((value) => budget && value > budget).length;
    if (overBudget > 0) breached = true;
    console.log(
      `  ${latencyClass.padEnd(14)} ${String(budget ?? "-").padStart(6)} ${String(
        percentile(values, 0.5)
      ).padStart(6)} ${String(p95).padStart(6)} ${String(Math.max(...values)).padStart(
        6
      )} ${String(overBudget).padStart(4)}`
    );
  }

  const instantWithProviders = records.filter(
    (record) => record.latencyClass === "instant" && record.providerCount > 0
  );
  console.log(
    `\ninstant turns that called a provider: ${instantWithProviders.length}`
  );
  console.log(
    `publication failures: ${records.filter((r) => r.publicationFailure).length}`
  );

  mkdirSync(resolve(process.cwd(), ".benchmarks"), { recursive: true });
  const output = resolve(
    process.cwd(),
    ".benchmarks",
    `stocksage-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(output, JSON.stringify(records, null, 2));
  console.log(`\nrecorded ${records.length} turns -> ${output}`);
  if (breached || instantWithProviders.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

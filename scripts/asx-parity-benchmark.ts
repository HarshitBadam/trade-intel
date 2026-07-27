/**
 * AU/US parity report.
 *
 * Measures the keyless Yahoo `.AX` numeric path directly, then compares what
 * the full StockSage path delivers for Australian companies against equivalent
 * US questions. Numeric quote parity and qualitative research depth are
 * deliberately reported as separate gates.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Paired questions that ask the same capability of each market. */
const PAIRS: { capability: string; au: string; us: string }[] = [
  {
    capability: "current_quote",
    au: "How is Macquarie doing today?",
    us: "How is Tesla doing today?",
  },
  {
    capability: "risk_analysis",
    au: "What are the key risks for Commonwealth Bank right now?",
    us: "What are the key risks for Nvidia right now?",
  },
  {
    capability: "comparison",
    au: "Compare Commonwealth Bank and Westpac on risk and valuation",
    us: "Compare Microsoft and Alphabet on risk and valuation",
  },
  {
    capability: "trailing_window",
    au: "How has ANZ performed over the last month?",
    us: "How has Apple performed over the last month?",
  },
  {
    capability: "outlook",
    au: "What is the outlook for NAB after its latest results?",
    us: "What is the outlook for Amazon after its latest results?",
  },
];

const CORE_ASX_TICKERS = ["MQG", "CBA", "NAB", "ANZ", "WBC"] as const;

type NativeMeasurement = {
  ticker: (typeof CORE_ASX_TICKERS)[number];
  durationMs: number;
  hit: boolean;
  instrumentCorrect: boolean;
  asOf?: string;
  windows: {
    day: boolean;
    week: boolean;
    month: boolean;
    year: boolean;
  };
};

type Measurement = {
  capability: string;
  market: "AU" | "US";
  message: string;
  latencyClass?: string;
  durationMs: number;
  providerCount: number;
  sourceCount: number;
  quoteCount: number;
  dataStatus?: string;
  criteriaAddressed: boolean;
  /** Proxy figures must name the ADR/ETF, never the local listing. */
  instrumentLabelled: boolean;
  /** Raw items returned per provider, before evidence filtering. */
  yieldByProvider: Record<string, number>;
};

const PROXY_SYMBOLS = /\b(MQBKY|CMWAY|NABZY|ANZGY|WBKCY|EWA)\b/;
const CRITERION_WORDS = /\b(risk|valuation|outlook|earnings|guidance|growth)\b/i;
const LOCAL_ASX_PRICE = /\bA\$\d/;
const NATIVE_ASX_LABEL = /\bASX:(?:MQG|CBA|NAB|ANZ|WBC)\b|native ASX listing/i;
const PROXY_LABEL = /\b(?:ADR|ETF) proxy\b/i;

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function rate(values: boolean[]): number {
  return values.length === 0
    ? 0
    : Math.round((values.filter(Boolean).length / values.length) * 100);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1
  );
  return sorted[Math.max(0, index)];
}

function allWindowsPresent(record: NativeMeasurement): boolean {
  return Object.values(record.windows).every(Boolean);
}

function fullAnswerInstrumentLabelled(text: string): boolean {
  const proxyMentioned = PROXY_SYMBOLS.test(text);
  const localPriceMentioned = LOCAL_ASX_PRICE.test(text);
  return (
    (!proxyMentioned || PROXY_LABEL.test(text)) &&
    (!localPriceMentioned || NATIVE_ASX_LABEL.test(text))
  );
}

async function main(): Promise<void> {
  loadEnvLocal();
  process.env.STOCKSAGE_TELEMETRY = "quiet";
  const { answerChat } = await import("../src/lib/stocksage/chat");
  const { onStockSageEvent } = await import("../src/lib/stocksage/telemetry");
  const { getYahooAsxQuotes, resetYahooAsxCache } = await import(
    "../src/lib/market-data/yahoo-asx"
  );
  const { LATENCY_BUDGET_MS, REGULAR_RETRIEVAL_CEILING_MS } = await import(
    "../src/lib/stocksage/budget"
  );

  const nativeMeasurements: NativeMeasurement[] = [];
  for (const ticker of CORE_ASX_TICKERS) {
    resetYahooAsxCache();
    const startedAt = Date.now();
    const quote = (await getYahooAsxQuotes([ticker]))[0];
    nativeMeasurements.push({
      ticker,
      durationMs: Date.now() - startedAt,
      hit: Boolean(quote),
      instrumentCorrect:
        quote?.ticker === ticker &&
        quote.instrumentSymbol === `${ticker}.AX` &&
        quote.venue === "ASX" &&
        quote.currency === "AUD" &&
        quote.proxySymbol === undefined,
      asOf: quote?.asOf,
      windows: {
        day: Number.isFinite(quote?.dayPct),
        week: quote?.weekPct != null && Number.isFinite(quote.weekPct),
        month: quote?.monthPct != null && Number.isFinite(quote.monthPct),
        year: quote?.yearPct != null && Number.isFinite(quote.yearPct),
      },
    });
  }
  resetYahooAsxCache();
  const batchStartedAt = Date.now();
  const batchQuotes = await getYahooAsxQuotes([...CORE_ASX_TICKERS]);
  const batchDurationMs = Date.now() - batchStartedAt;
  resetYahooAsxCache();

  const measurements: Measurement[] = [];
  let pending: {
    latencyClass?: string;
    providerCount?: number;
    sourceCount?: number;
    yieldByProvider?: Record<string, number>;
  } = {};
  const stop = onStockSageEvent((event) => {
    if (event.event === "evidence_yield") {
      pending.yieldByProvider = event.providerCalls;
      return;
    }
    if (event.event !== "request_complete") return;
    pending = {
      ...pending,
      latencyClass: event.latencyClass,
      providerCount: event.providerCount,
      sourceCount: event.sourceCount,
    };
  });

  for (const pair of PAIRS) {
    for (const market of ["AU", "US"] as const) {
      const message = market === "AU" ? pair.au : pair.us;
      pending = {};
      const startedAt = Date.now();
      const reply = await answerChat({
        message,
        history: [],
        sessionId: `parity-${pair.capability}-${market}`,
      });
      measurements.push({
        capability: pair.capability,
        market,
        message,
        durationMs: Date.now() - startedAt,
        quoteCount: (reply.text.match(/\$\d/g) ?? []).length,
        dataStatus: reply.dataStatus,
        criteriaAddressed:
          !CRITERION_WORDS.test(message) || CRITERION_WORDS.test(reply.text),
        instrumentLabelled:
          market === "US" ? true : fullAnswerInstrumentLabelled(reply.text),
        latencyClass: pending.latencyClass,
        providerCount: pending.providerCount ?? 0,
        sourceCount: pending.sourceCount ?? 0,
        yieldByProvider: pending.yieldByProvider ?? {},
      });
    }
  }
  stop();

  const batchByTicker = new Map(
    batchQuotes.map((quote) => [quote.ticker, quote])
  );
  const batchInstrumentCorrect = CORE_ASX_TICKERS.every((ticker) => {
    const quote = batchByTicker.get(ticker);
    return (
      quote?.instrumentSymbol === `${ticker}.AX` &&
      quote.venue === "ASX" &&
      quote.currency === "AUD" &&
      quote.proxySymbol === undefined
    );
  });
  const nativeSummary = {
    provider: "yahoo_chart_keyless",
    hitRate: rate(nativeMeasurements.map((record) => record.hit)),
    instrumentRate: rate(
      nativeMeasurements.map((record) => record.instrumentCorrect)
    ),
    allWindowsRate: rate(nativeMeasurements.map(allWindowsPresent)),
    p50Ms: percentile(
      nativeMeasurements.map((record) => record.durationMs),
      0.5
    ),
    p95Ms: percentile(
      nativeMeasurements.map((record) => record.durationMs),
      0.95
    ),
    maxMs: Math.max(
      0,
      ...nativeMeasurements.map((record) => record.durationMs)
    ),
    batchHits: batchQuotes.length,
    batchDurationMs,
    batchInstrumentCorrect,
  };

  console.log("native provider: Yahoo Finance chart (keyless, delayed)");
  console.log("paid ASX feeds: not required");
  console.log("ticker  hit  instr  D/W/M/Y       ms  asOf");
  for (const record of nativeMeasurements) {
    console.log(
      [
        record.ticker.padEnd(7),
        (record.hit ? "yes" : "NO").padEnd(4),
        (record.instrumentCorrect ? "ok" : "BAD").padEnd(6),
        Object.values(record.windows)
          .map((present) => (present ? "y" : "-"))
          .join("/")
          .padEnd(9),
        String(record.durationMs).padStart(6),
        record.asOf ?? "-",
      ].join(" ")
    );
  }
  console.log(
    `native summary: hits ${nativeSummary.hitRate}%, instruments ${nativeSummary.instrumentRate}%, all windows ${nativeSummary.allWindowsRate}%, p50/p95/max ${nativeSummary.p50Ms}/${nativeSummary.p95Ms}/${nativeSummary.maxMs}ms, batch ${nativeSummary.batchHits}/${CORE_ASX_TICKERS.length} in ${batchDurationMs}ms`
  );

  console.log("");
  console.log(
    "capability          market  status       prov  src  crit  instr    ms  yield"
  );
  for (const record of measurements) {
    console.log(
      [
        record.capability.padEnd(19),
        record.market.padEnd(7),
        (record.dataStatus ?? "-").padEnd(12),
        String(record.providerCount).padStart(4),
        String(record.sourceCount).padStart(4),
        (record.criteriaAddressed ? "yes" : "NO").padStart(5),
        (record.instrumentLabelled ? "ok" : "BAD").padStart(6),
        String(record.durationMs).padStart(6),
        Object.entries(record.yieldByProvider)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${name}:${count}`)
          .join(",") || "-",
      ].join(" ")
    );
  }

  const summary = (["AU", "US"] as const).map((market) => {
    const rows = measurements.filter((record) => record.market === market);
    return {
      market,
      answered: rate(rows.map((row) => row.dataStatus !== "unavailable")),
      sourceDepth: mean(rows.map((row) => row.sourceCount)),
      criteria: rate(rows.map((row) => row.criteriaAddressed)),
      instruments: rate(rows.map((row) => row.instrumentLabelled)),
      latencyMs: mean(rows.map((row) => row.durationMs)),
    };
  });
  console.log("\nmarket  answered%  sourceDepth  criteria%  instrument%  meanMs");
  for (const row of summary) {
    console.log(
      `${row.market.padEnd(7)} ${String(row.answered).padStart(9)} ${String(
        row.sourceDepth
      ).padStart(12)} ${String(row.criteria).padStart(10)} ${String(
        row.instruments
      ).padStart(12)} ${String(row.latencyMs).padStart(7)}`
    );
  }

  const au = summary.find((row) => row.market === "AU")!;
  const us = summary.find((row) => row.market === "US")!;
  const numericFailures: string[] = [];
  if (nativeSummary.hitRate < 100) {
    numericFailures.push(
      `Yahoo covered ${nativeSummary.hitRate}% of core .AX tickers`
    );
  }
  if (nativeSummary.instrumentRate < 100 || !batchInstrumentCorrect) {
    numericFailures.push(
      `Yahoo native ASX/AUD instrument identity was not correct for every core ticker`
    );
  }
  if (nativeSummary.allWindowsRate < 100) {
    numericFailures.push(
      `Yahoo day/week/month/year windows were complete for ${nativeSummary.allWindowsRate}% of core tickers`
    );
  }
  if (nativeSummary.batchHits !== CORE_ASX_TICKERS.length) {
    numericFailures.push(
      `Yahoo batch returned ${nativeSummary.batchHits}/${CORE_ASX_TICKERS.length} core tickers`
    );
  }
  if (batchDurationMs > REGULAR_RETRIEVAL_CEILING_MS) {
    numericFailures.push(
      `Yahoo batch took ${batchDurationMs}ms, above the ${REGULAR_RETRIEVAL_CEILING_MS}ms regular retrieval ceiling`
    );
  }
  if (au.instruments < 100) {
    numericFailures.push(
      `AU answer output did not label every native/proxy instrument correctly`
    );
  }

  const researchFailures: string[] = [];
  if (au.answered < us.answered) {
    researchFailures.push(
      `AU answered ${au.answered}% of capabilities versus US ${us.answered}%`
    );
  }
  if (au.criteria < us.criteria) {
    researchFailures.push(
      `AU addressed ${au.criteria}% of requested criteria versus US ${us.criteria}%`
    );
  }
  if (au.sourceDepth * 2 < us.sourceDepth) {
    researchFailures.push(
      `AU source depth ${au.sourceDepth} is less than half of US ${us.sourceDepth}`
    );
  }

  const latencyFailures = measurements
    .filter((record) => {
      const budget =
        LATENCY_BUDGET_MS[
          record.latencyClass as keyof typeof LATENCY_BUDGET_MS
        ];
      return budget !== undefined && record.durationMs > budget;
    })
    .map(
      (record) =>
        `${record.capability}/${record.market} took ${record.durationMs}ms (budget ${LATENCY_BUDGET_MS[record.latencyClass as keyof typeof LATENCY_BUDGET_MS]}ms)`
    );

  console.log("\ngates");
  console.log(
    `  core Yahoo .AX coverage: ${numericFailures.some((failure) => failure.startsWith("Yahoo covered") || failure.startsWith("Yahoo batch")) ? "FAIL" : "PASS"}`
  );
  console.log(
    `  native ASX/AUD identity: ${numericFailures.some((failure) => /identity|instrument/.test(failure)) ? "FAIL" : "PASS"}`
  );
  console.log(
    `  Yahoo return windows: ${numericFailures.some((failure) => failure.includes("windows")) ? "FAIL" : "PASS"}`
  );
  console.log(
    `  latency budgets: ${latencyFailures.length === 0 && batchDurationMs <= REGULAR_RETRIEVAL_CEILING_MS ? "PASS" : "FAIL"}`
  );
  console.log(
    `  qualitative AU/US depth: ${researchFailures.length === 0 ? "PASS" : "FAIL"}`
  );

  console.log("");
  console.log(
    numericFailures.length === 0
      ? "NUMERIC VERDICT: Yahoo native .AX quote and return parity passes."
      : "NUMERIC VERDICT: Yahoo native .AX parity does not pass."
  );
  for (const failure of numericFailures) console.log(`  - ${failure}`);
  console.log(
    researchFailures.length === 0
      ? "QUALITATIVE VERDICT: AU/US research depth passes on the configured Tavily/Astra path."
      : "QUALITATIVE VERDICT: AU/US research depth does not pass on the configured Tavily/Astra path."
  );
  for (const failure of researchFailures) console.log(`  - ${failure}`);
  if (latencyFailures.length > 0) {
    console.log("LATENCY VERDICT: one or more full-answer turns exceeded budget.");
    for (const failure of latencyFailures) console.log(`  - ${failure}`);
  } else {
    console.log("LATENCY VERDICT: full-answer turns stayed within budget.");
  }

  const failures = [
    ...numericFailures,
    ...researchFailures,
    ...latencyFailures,
  ];
  mkdirSync(resolve(process.cwd(), ".benchmarks"), { recursive: true });
  const output = resolve(
    process.cwd(),
    ".benchmarks",
    `asx-parity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(
    output,
    JSON.stringify(
      {
        nativeSummary,
        nativeMeasurements,
        requiredNumericProvider: "yahoo_chart_keyless",
        summary,
        numericFailures,
        researchFailures,
        latencyFailures,
        measurements,
      },
      null,
      2
    )
  );
  console.log(`\nrecorded ${measurements.length} measurements -> ${output}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

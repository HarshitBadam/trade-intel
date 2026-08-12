import { loadEnvLocal } from "./env";

const PAIRS = [
  {
    capability: "current_quote",
    au: "How is Macquarie doing today?",
    us: "How is Tesla doing today?",
  },
  {
    capability: "comparison",
    au: "Compare Commonwealth Bank and Westpac over the last month",
    us: "Compare Microsoft and Alphabet over the last month",
  },
] as const;

const CORE_ASX_TICKERS = ["MQG", "CBA", "NAB", "ANZ", "WBC"] as const;

function sessionDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  loadEnvLocal();
  process.env.STOCKSAGE_TELEMETRY = "quiet";
  const [{ answerChat }, { getBarsForRange }] = await Promise.all([
    import("../src/lib/stocksage/chat"),
    import("../src/lib/market-data/range-bars"),
  ]);

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 45);

  const native = await Promise.all(
    CORE_ASX_TICKERS.map(async (ticker) => {
      const startedAt = Date.now();
      const series = await getBarsForRange({
        ticker,
        instrumentSymbol: `${ticker}.AX`,
        venue: "ASX",
        calendar: "AU",
        granularity: "1Day",
        startSession: sessionDate(start),
        endSession: sessionDate(end),
        adjusted: true,
      });
      return {
        ticker,
        durationMs: Date.now() - startedAt,
        status: series.status,
        provider: series.provenance?.provider,
        instrumentSymbol: series.instrumentSymbol,
        barCount: series.bars.length,
      };
    })
  );

  const conversations = [];
  for (const pair of PAIRS) {
    for (const market of ["AU", "US"] as const) {
      const message = market === "AU" ? pair.au : pair.us;
      const startedAt = Date.now();
      const reply = await answerChat({
        message,
        history: [],
        sessionId: `parity-${pair.capability}-${market}`,
      });
      conversations.push({
        capability: pair.capability,
        market,
        durationMs: Date.now() - startedAt,
        dataStatus: reply.dataStatus,
        citationCount: reply.citationUrls?.length ?? 0,
        retryable: reply.retryable ?? false,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        native,
        conversations,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

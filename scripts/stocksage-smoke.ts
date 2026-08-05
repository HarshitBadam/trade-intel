import assert from "node:assert/strict";
import type { RetrievalProviders } from "../src/lib/stocksage/evidence/retrieve";

async function main() {
  delete process.env.GROQ_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.ASTRA_DB_APPLICATION_TOKEN;
  delete process.env.LANGFLOW_API_KEY;
  const { answerChat } = await import("../src/lib/stocksage/chat");
  const calls = { quotes: 0, astra: 0, tavily: 0 };
  const providers: RetrievalProviders = {
    quotes: async () => {
      calls.quotes += 1;
      return [
        {
          ticker: "AAPL",
          price: 210,
          asOf: "2026-07-10",
          dayPct: 1,
          fewDaysPct: 1.5,
          weekPct: 2,
          monthPct: 3,
          yearPct: 12,
        },
      ];
    },
    astra: async () => {
      calls.astra += 1;
      return [];
    },
    tavily: async () => {
      calls.tavily += 1;
      return [];
    },
  };
  const socialStartedAt = Date.now();
  const social = await answerChat(
    { message: "what's up my bitch ass hoe", history: [] },
    { retrievalProviders: providers }
  );
  const socialMs = Date.now() - socialStartedAt;
  const stableStartedAt = Date.now();
  const stable = await answerChat(
    { message: "What is a P/E ratio?", history: [] },
    { retrievalProviders: providers }
  );
  const stableMs = Date.now() - stableStartedAt;
  const currentStartedAt = Date.now();
  const current = await answerChat(
    { message: "What is Apple trading at?", history: [] },
    { retrievalProviders: providers }
  );
  const currentMs = Date.now() - currentStartedAt;
  assert.match(social.text, /Hey/i);
  assert.match(stable.text, /earnings per share/i);
  assert.match(current.text, /\$210\.00/);
  assert.deepEqual(calls, { quotes: 1, astra: 1, tavily: 0 });
  assert.ok(socialMs < 250, `social fast path took ${socialMs}ms`);
  assert.ok(stableMs < 250, `stable fast path took ${stableMs}ms`);
  assert.ok(currentMs < 1_000, `mocked current path took ${currentMs}ms`);
  console.info(
    `StockSage smoke: ok (social=${socialMs}ms stable=${stableMs}ms current=${currentMs}ms)`
  );
}

main().catch((error) => {
  console.error(
    `StockSage smoke: failed (${error instanceof Error ? error.name : "unknown"})`
  );
  process.exitCode = 1;
});

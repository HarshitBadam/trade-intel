import assert from "node:assert/strict";
import { answerChat } from "../src/lib/stocksage/chat";
import type { SimpleRuntimeDependencies } from "../src/lib/stocksage/simple-runtime";

async function main() {
  const calls = { extraction: 0, market: 0, composition: 0 };
  const dependencies: SimpleRuntimeDependencies = {
    now: new Date("2026-08-12T22:00:00.000Z"),
    extractPlan: async () => {
      calls.extraction += 1;
      return {
        prices: [["AAPL", "2026-08-12"]],
        news: [],
        rankings: [],
      };
    },
    retrieveMarket: async () => {
      calls.market += 1;
      return [
        {
          entityId: "ticker:AAPL",
          name: "Apple",
          ticker: "AAPL",
          calendar: "US",
          status: "complete",
          provider: "fixture",
          instrumentSymbol: "AAPL",
          currency: "USD",
          requestedPoints: [
            {
              requestedDate: "2026-08-12",
              session: "2026-08-12",
              close: 230,
            },
          ],
          firstClose: 225,
          lastClose: 230,
          returnPct: 2.2222,
          returnKind: "single_session",
        },
      ];
    },
    retrieveGeneralNews: async () => [],
    retrieveFocusedNews: async () => ({ evidence: [], outcomes: [] }),
    retrieveRankingOutcomes: async () => [],
    composeAnswer: async () => {
      calls.composition += 1;
      return "Apple closed at $230 in the smoke fixture.";
    },
  };

  const socialStartedAt = Date.now();
  const social = await answerChat(
    { message: "Hey StockSage, what's up?", history: [] },
    dependencies
  );
  const socialMs = Date.now() - socialStartedAt;

  const currentStartedAt = Date.now();
  const current = await answerChat(
    { message: "What is Apple trading at?", history: [] },
    dependencies
  );
  const currentMs = Date.now() - currentStartedAt;

  assert.match(social.text, /Hey/i);
  assert.equal(social.presentationMode, "social");
  assert.match(current.text, /\$230/);
  assert.equal(current.presentationMode, "current_finance");
  assert.deepEqual(calls, { extraction: 1, market: 1, composition: 1 });
  assert.ok(socialMs < 250, `social fast path took ${socialMs}ms`);
  assert.ok(currentMs < 1_000, `mocked current path took ${currentMs}ms`);
  console.info(
    `StockSage smoke: ok (social=${socialMs}ms current=${currentMs}ms)`
  );
}

main().catch((error) => {
  console.error(
    `StockSage smoke: failed (${error instanceof Error ? error.message : "unknown"})`
  );
  process.exitCode = 1;
});

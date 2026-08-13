import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { answerChat } from "../../src/lib/stocksage/chat";

test("the public chat facade delegates directly to the simple runtime", async () => {
  let composed = false;
  const reply = await answerChat(
    { message: "How is Apple doing today?", history: [] },
    {
      now: new Date("2026-08-12T22:00:00.000Z"),
      extractPlan: async () => ({
        prices: [["AAPL", "2026-08-12"]],
        news: [],
        rankings: [],
      }),
      retrieveMarket: async () => [
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
      ],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async () => ({ evidence: [], outcomes: [] }),
      retrieveRankingOutcomes: async () => [],
      composeAnswer: async () => {
        composed = true;
        return "Apple closed at $230 in the fixture.";
      },
    }
  );

  assert.equal(composed, true);
  assert.equal(reply.text, "Apple closed at $230 in the fixture.");
  assert.equal(reply.presentationMode, "current_finance");
  assert.equal(reply.state?.version, 1);
});

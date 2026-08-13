import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { runSimpleChatAdapter } from "../../src/lib/stocksage/simple-runtime";
import type { ConversationState } from "../../src/lib/stocksage/types";

const MQG_STATE: ConversationState = {
  version: 1,
  revision: 2,
  entities: [
    {
      id: "ticker:MQG",
      name: "Macquarie Group",
      query: "Macquarie Group",
      ticker: "MQG",
      market: "au",
    },
  ],
  explicitEntitySet: ["ticker:MQG"],
  criteria: [],
  focusEntityIds: ["ticker:MQG"],
};

test("an unusual first-turn greeting gets semantic social recovery", async () => {
  let recoveryCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "Oh lord welcome hello again",
      history: [],
    },
    {
      extractPlan: async () => ({ prices: [], news: [], rankings: [] }),
      recoverContextualTurn: async () => {
        recoveryCalls += 1;
        return {
          disposition: "social",
          plan: { prices: [], news: [], rankings: [] },
        };
      },
    }
  );

  assert.equal(recoveryCalls, 1);
  assert.equal(reply.presentationMode, "social");
  assert.equal(reply.presentationReason, "contextual_social");
  assert.match(reply.text, /good to see you/i);
});

test("a story fragment inherits the sole active company", async () => {
  let extractionCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "whats up with the whistle-blower news",
      history: [
        { role: "user", text: "whats up with Macquarie" },
        { role: "ai", text: "Macquarie Group closed at A$260.08." },
      ],
      state: MQG_STATE,
    },
    {
      extractPlan: async () => {
        extractionCalls += 1;
        return { prices: [], news: [], rankings: [] };
      },
      recoverContextualTurn: async (request, hints) => {
        assert.equal(request.state?.entities[0]?.ticker, "MQG");
        assert.deepEqual(hints.resolvedCurrentEntities, []);
        return {
          disposition: "research",
          plan: {
            prices: [["MQG", "2026-08-13"]],
            news: ["Macquarie Group whistleblower news"],
            rankings: [],
          },
        };
      },
      retrieveMarket: async () => [],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async (queries) => {
        assert.deepEqual(queries, ["Macquarie Group whistleblower news"]);
        return { evidence: [], outcomes: [] };
      },
      retrieveRankingOutcomes: async () => [],
      composeAnswer: async () => "Recovered Macquarie whistleblower news.",
    }
  );

  assert.equal(extractionCalls, 0);
  assert.equal(reply.text, "Recovered Macquarie whistleblower news.");
});

import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import type { ChatRequest } from "../../src/lib/stocksage/types";
import {
  extractEvidencePlan,
  recoverContextualEvidencePlan,
} from "../../src/lib/stocksage/simple/extraction";

const NOW = new Date("2026-08-12T22:00:00.000Z");
const TODAY = "2026-08-12";

test("primary extraction receives entities resolved from the current wording", async () => {
  const entity = {
    id: "ticker:MQG",
    name: "Macquarie Group",
    query: "Macquarie Group",
    ticker: "MQG",
    market: "au" as const,
  };
  let suppliedContext = "";
  const plan = await extractEvidencePlan(
    {
      message: "What about the time they did that strange thing?",
      history: [{ role: "user", text: "Tell me about Macquarie" }],
      state: {
        version: 1,
        revision: 2,
        entities: [entity],
        explicitEntitySet: [entity.id],
        criteria: [],
      },
    },
    NOW,
    async (args) => {
      suppliedContext = args.user ?? "";
      return {
        prices: [["MQG", TODAY]],
        news: ["Macquarie Group strange thing"],
        rankings: [],
      };
    },
    { resolvedCurrentEntities: [entity] }
  );

  const context = JSON.parse(suppliedContext);
  assert.equal(context.currentTurnResolvedEntities[0].ticker, "MQG");
  assert.deepEqual(plan.news, ["Macquarie Group strange thing"]);
});

test("contextual recovery receives structured history and current resolved state", async () => {
  const request: ChatRequest = {
    message: "circle back to the earlier investigation",
    history: [
      { role: "user", text: "Tell me about Macquarie" },
      {
        role: "ai",
        text: "Macquarie is reviewing whistleblower allegations involving KPMG.",
      },
    ],
    state: {
      version: 1,
      revision: 3,
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
    },
  };
  let suppliedContext = "";
  let suppliedInstructions = "";
  const recovery = await recoverContextualEvidencePlan(
    request,
    NOW,
    async (args) => {
      suppliedContext = args.user ?? "";
      suppliedInstructions = args.system ?? "";
      return {
        disposition: "research",
        prices: [["MQG", TODAY]],
        news: ["Macquarie KPMG whistleblower allegations"],
        rankings: [],
      };
    },
    { resolvedCurrentEntities: request.state?.entities ?? [] }
  );

  const context = JSON.parse(suppliedContext);
  assert.equal(context.currentMessage, request.message);
  assert.equal(context.recentConversation.length, 2);
  assert.equal(context.activeState.entities[0].ticker, "MQG");
  assert.equal(
    context.currentTurnResolution.resolvedEntities[0].ticker,
    "MQG"
  );
  assert.equal(recovery.disposition, "research");
  assert.match(suppliedInstructions, /unfamiliar slang action/i);
  assert.deepEqual(recovery.plan.news, [
    "Macquarie KPMG whistleblower allegations",
  ]);
});

test("contextual recovery discards evidence attached to a non-research disposition", async () => {
  const recovery = await recoverContextualEvidencePlan(
    {
      message: "sounds good",
      history: [{ role: "user", text: "How is Apple doing?" }],
    },
    NOW,
    async () => ({
      disposition: "acknowledgement",
      prices: [["AAPL", TODAY]],
      news: ["Apple news"],
      rankings: [],
    })
  );

  assert.equal(recovery.disposition, "acknowledgement");
  assert.deepEqual(recovery.plan, { prices: [], news: [], rankings: [] });
});

test("contextual recovery downgrades an empty research result to ambiguous", async () => {
  const recovery = await recoverContextualEvidencePlan(
    {
      message: "what about that?",
      history: [{ role: "user", text: "How is Apple doing?" }],
    },
    NOW,
    async () => ({
      disposition: "research",
      prices: [],
      news: [],
      rankings: [],
    })
  );

  assert.equal(recovery.disposition, "ambiguous");
  assert.deepEqual(recovery.plan, { prices: [], news: [], rankings: [] });
});

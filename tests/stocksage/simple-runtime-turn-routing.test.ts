import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { runSimpleChatAdapter } from "../../src/lib/stocksage/simple-runtime";

test("an unrecognized continuation cannot replay the previous computation", async () => {
  let extractionCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "i guess that fine",
      history: [
        { role: "user", text: "Show the top and bottom US performers today" },
        { role: "ai", text: "Here are the requested rankings." },
      ],
    },
    {
      extractPlan: async () => {
        extractionCalls += 1;
        return { prices: [], news: [], rankings: [["US", "2026-08-12"]] };
      },
    }
  );

  assert.equal(extractionCalls, 0);
  assert.match(reply.text, /didn’t quite catch that/i);
  assert.equal(reply.presentationMode, "clarification");
  assert.equal(reply.presentationReason, "ambiguous_follow_up");
  assert.equal(reply.live, false);
});

test("clear terse follow-ups still reach semantic extraction", async () => {
  let extractionCalls = 0;
  const history = [
    { role: "user" as const, text: "How is Tesla doing this month?" },
    { role: "ai" as const, text: "Tesla has risen this month." },
  ];

  for (const message of ["Why?", "More news", "Same period", "Continue"]) {
    await runSimpleChatAdapter(
      { message, history },
      {
        extractPlan: async () => {
          extractionCalls += 1;
          return { prices: [], news: [], rankings: [] };
        },
      }
    );
  }

  assert.equal(extractionCalls, 4);
});

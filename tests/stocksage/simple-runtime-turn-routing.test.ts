import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { runSimpleChatAdapter } from "../../src/lib/stocksage/simple-runtime";
import type { ConversationState } from "../../src/lib/stocksage/types";

const MQG_STATE: ConversationState = {
  version: 1,
  revision: 4,
  entities: [
    {
      id: "ticker:MQG",
      name: "Macquarie Group",
      query: "Macquarie Group",
      ticker: "MQG",
      market: "au",
      jurisdiction: "Australia",
    },
  ],
  explicitEntitySet: ["ticker:MQG"],
  criteria: [],
  focusEntityIds: ["ticker:MQG"],
};

const EMPTY_FOCUSED_NEWS = {
  evidence: [],
  outcomes: [],
};

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

test("a topic return rejected by the fast gate can recover from conversation context", async () => {
  let extractionCalls = 0;
  let recoveryCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "circle back onto the whistleblower case.",
      history: [
        { role: "user", text: "What is up with Macquarie Group?" },
        { role: "ai", text: "Macquarie Group is trading at..." },
        { role: "user", text: "What about the whistleblower news?" },
        {
          role: "ai",
          text: "Macquarie opened an enquiry into KPMG after a whistleblower allegation.",
        },
      ],
      state: MQG_STATE,
    },
    {
      extractPlan: async () => {
        extractionCalls += 1;
        return { prices: [], news: [], rankings: [] };
      },
      recoverContextualTurn: async (request) => {
        recoveryCalls += 1;
        assert.equal(request.state?.entities[0]?.ticker, "MQG");
        assert.match(
          request.history.map((turn) => turn.text).join(" "),
          /whistleblower/i
        );
        return {
          disposition: "research",
          plan: {
            prices: [["MQG", "2026-08-13"]],
            news: ["Macquarie KPMG whistleblower allegations"],
            rankings: [],
          },
        };
      },
      retrieveMarket: async () => [],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async (queries) => {
        assert.deepEqual(queries, [
          "Macquarie KPMG whistleblower allegations",
        ]);
        return EMPTY_FOCUSED_NEWS;
      },
      retrieveRankingOutcomes: async () => [],
      composeAnswer: async () => "Recovered whistleblower answer.",
    }
  );

  assert.equal(recoveryCalls, 1);
  assert.equal(extractionCalls, 0);
  assert.equal(reply.text, "Recovered whistleblower answer.");
});

test("an empty pronoun-event extraction gets one bounded contextual recovery", async () => {
  let extractionCalls = 0;
  let recoveryCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "What about the time they cranked that Soulja boy?",
      history: [
        { role: "user", text: "What is up with Macquarie Group?" },
        { role: "ai", text: "Macquarie Group is trading at..." },
      ],
      state: MQG_STATE,
    },
    {
      extractPlan: async (request) => {
        extractionCalls += 1;
        assert.equal(request.state?.entities[0]?.ticker, "MQG");
        return { prices: [], news: [], rankings: [] };
      },
      recoverContextualTurn: async (_request, hints) => {
        recoveryCalls += 1;
        assert.equal(hints.resolvedCurrentEntities[0]?.ticker, "MQG");
        return {
          disposition: "research",
          plan: {
            prices: [["MQG", "2026-08-13"]],
            news: ["Macquarie Group cranked Soulja Boy"],
            rankings: [],
          },
        };
      },
      retrieveMarket: async () => [],
      retrieveGeneralNews: async () => [],
      retrieveFocusedNews: async () => EMPTY_FOCUSED_NEWS,
      retrieveRankingOutcomes: async () => [],
      composeAnswer: async () => "No reliable reporting found.",
    }
  );

  assert.equal(extractionCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(reply.text, "No reliable reporting found.");
});

test("a resolved current entity cannot be reclassified as unrelated", async () => {
  const reply = await runSimpleChatAdapter(
    {
      message: "What about the time they did that strange thing?",
      history: [
        { role: "user", text: "What is up with Macquarie Group?" },
        { role: "ai", text: "Macquarie Group is trading at..." },
      ],
      state: MQG_STATE,
    },
    {
      extractPlan: async () => ({ prices: [], news: [], rankings: [] }),
      recoverContextualTurn: async () => ({
        disposition: "out_of_scope",
        plan: { prices: [], news: [], rankings: [] },
      }),
    }
  );

  assert.equal(reply.presentationMode, "clarification");
  assert.equal(reply.presentationReason, "contextual_follow_up_ambiguous");
  assert.match(reply.text, /didn’t quite catch/i);
});

test("broad carry-forward does not prove an unrelated turn references the active entity", async () => {
  const reply = await runSimpleChatAdapter(
    {
      message: "Why is sourdough popular?",
      history: [
        { role: "user", text: "What is up with Macquarie Group?" },
        { role: "ai", text: "Macquarie Group is trading at..." },
      ],
      state: MQG_STATE,
    },
    {
      extractPlan: async () => ({ prices: [], news: [], rankings: [] }),
      recoverContextualTurn: async (_request, hints) => {
        assert.deepEqual(hints.resolvedCurrentEntities, []);
        return {
          disposition: "out_of_scope",
          plan: { prices: [], news: [], rankings: [] },
        };
      },
    }
  );

  assert.equal(reply.presentationReason, "contextual_out_of_scope");
  assert.match(reply.text, /financial markets/i);
});

test("structural reference clarifications cannot be overridden by recovery", async () => {
  let recoveryCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "What about the former?",
      history: [
        { role: "user", text: "What is up with Macquarie Group?" },
        { role: "ai", text: "Macquarie Group is trading at..." },
      ],
      state: MQG_STATE,
    },
    {
      recoverContextualTurn: async () => {
        recoveryCalls += 1;
        return {
          disposition: "research",
          plan: {
            prices: [["MQG", "2026-08-13"]],
            news: [],
            rankings: [],
          },
        };
      },
    }
  );

  assert.equal(recoveryCalls, 0);
  assert.equal(reply.presentationReason, "ambiguous_ordered_reference");
  assert.match(reply.text, /which two entities/i);
});

test("contextual acknowledgement cannot replay prior company research", async () => {
  let extractionCalls = 0;
  let retrievalCalls = 0;
  const reply = await runSimpleChatAdapter(
    {
      message: "i guess that fine",
      history: [
        { role: "user", text: "How is Tesla doing?" },
        { role: "ai", text: "Tesla rose in the latest session." },
      ],
      state: {
        version: 1,
        revision: 2,
        entities: [
          {
            id: "ticker:TSLA",
            name: "Tesla",
            query: "Tesla",
            ticker: "TSLA",
            market: "us",
          },
        ],
        explicitEntitySet: ["ticker:TSLA"],
        criteria: [],
        focusEntityIds: ["ticker:TSLA"],
      },
    },
    {
      extractPlan: async () => {
        extractionCalls += 1;
        return {
          prices: [["TSLA", "2026-08-13"]],
          news: [],
          rankings: [],
        };
      },
      recoverContextualTurn: async () => ({
        disposition: "acknowledgement",
        plan: { prices: [], news: [], rankings: [] },
      }),
      retrieveMarket: async () => {
        retrievalCalls += 1;
        return [];
      },
    }
  );

  assert.equal(extractionCalls, 0);
  assert.equal(retrievalCalls, 0);
  assert.equal(reply.presentationMode, "social");
  assert.equal(reply.presentationReason, "contextual_acknowledgement");
  assert.match(reply.text, /no worries/i);
});

test("a failed contextual recovery preserves the existing clarification fallback", async () => {
  const reply = await runSimpleChatAdapter(
    {
      message: "circle back onto that case.",
      history: [
        { role: "user", text: "How is Tesla doing?" },
        { role: "ai", text: "Tesla rose in the latest session." },
      ],
      state: MQG_STATE,
    },
    {
      recoverContextualTurn: async () => {
        throw new Error("recovery unavailable");
      },
    }
  );

  assert.equal(reply.presentationMode, "clarification");
  assert.equal(reply.presentationReason, "ambiguous_follow_up");
  assert.match(reply.text, /didn’t quite catch/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  activeChatMessageVersion,
  appendChatMessageVersion,
  chatHistory,
  createChatMessage,
  selectChatMessageVersion,
} from "../../src/components/chat/chat-message-model";

test("regenerated responses keep their original transcript position", () => {
  const question = createChatMessage("question", "user", {
    text: "Compare the banks",
  });
  const answer = createChatMessage(
    "answer",
    "ai",
    { text: "Original answer" },
    true
  );
  const laterQuestion = createChatMessage("later-question", "user", {
    text: "Which is cheapest?",
  });

  const updated = appendChatMessageVersion(
    [question, answer, laterQuestion],
    "answer",
    { text: "Regenerated answer" }
  );

  assert.deepEqual(
    updated.map((message) => message.id),
    ["question", "answer", "later-question"]
  );
  const updatedAnswer = updated[1];
  assert.ok(updatedAnswer);
  assert.equal(updatedAnswer.versions.length, 2);
  assert.equal(
    activeChatMessageVersion(updatedAnswer).text,
    "Regenerated answer"
  );
  assert.equal(updated[2], laterQuestion);
});

test("version selection controls the answer included in chat history", () => {
  const answer = appendChatMessageVersion(
    [
      createChatMessage("welcome", "ai", { text: "Welcome" }),
      createChatMessage("question", "user", { text: "Question" }),
      createChatMessage("answer", "ai", { text: "First answer" }, true),
    ],
    "answer",
    { text: "Second answer" }
  );

  assert.deepEqual(chatHistory(answer), [
    { role: "user", text: "Question" },
    { role: "ai", text: "Second answer" },
  ]);

  const selected = selectChatMessageVersion(answer, "answer", 0);
  assert.deepEqual(chatHistory(selected), [
    { role: "user", text: "Question" },
    { role: "ai", text: "First answer" },
  ]);
});

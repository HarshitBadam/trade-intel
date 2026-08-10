import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitClarification,
  effectivePresentationMode,
  nextDeepAction,
  presentationAccentClass,
  presentationBadge,
} from "../src/components/chat/presentation";

test("presentationBadge never exposes internal presentation tags", () => {
  for (const mode of [
    undefined,
    "social",
    "stable_finance",
    "current_finance",
    "comparison",
    "clarification",
    "limited_evidence",
    "no_evidence",
    "deep_pending",
    "deep_failed",
  ] as const) {
    assert.equal(presentationBadge(mode), null);
  }
});

test("presentationAccentClass never exposes internal status through color", () => {
  for (const mode of [
    undefined,
    "social",
    "stable_finance",
    "current_finance",
    "comparison",
    "clarification",
    "limited_evidence",
    "no_evidence",
    "deep_pending",
    "deep_failed",
  ] as const) {
    assert.equal(presentationAccentClass(mode), "");
  }
});

test("effectivePresentationMode lets outstanding Deep Research state take over the mode", () => {
  assert.equal(effectivePresentationMode("stable_finance", "pending"), "deep_pending");
  assert.equal(effectivePresentationMode("comparison", "failure"), "deep_failed");
});

test("effectivePresentationMode falls back to the base mode once Deep Research is idle/absent/succeeded", () => {
  assert.equal(effectivePresentationMode("current_finance", undefined), "current_finance");
  assert.equal(effectivePresentationMode("current_finance", "idle"), "current_finance");
  assert.equal(effectivePresentationMode("current_finance", "success"), "current_finance");
});

test("nextDeepAction starts fresh work when idle/never attempted", () => {
  assert.equal(nextDeepAction(undefined), "start");
  assert.equal(nextDeepAction("idle"), "start");
});

test("nextDeepAction retries with a new attempt identity only after a failure", () => {
  assert.equal(nextDeepAction("failure"), "retry");
  assert.equal(nextDeepAction("failure", false), "blocked");
});

test("nextDeepAction blocks duplicate clicks while pending or already succeeded", () => {
  assert.equal(nextDeepAction("pending"), "blocked");
  assert.equal(nextDeepAction("success"), "blocked");
});

test("effective modes expose neither text badges nor colored status accents", () => {
  const effective = effectivePresentationMode("current_finance", "pending");
  assert.equal(effective, "deep_pending");
  assert.equal(presentationBadge(effective), null);
  assert.equal(presentationAccentClass(effective), "");

  const failedEffective = effectivePresentationMode("comparison", "failure");
  assert.equal(failedEffective, "deep_failed");
  assert.equal(presentationBadge(failedEffective), null);
  assert.equal(presentationAccentClass(failedEffective), "");
});

test("canSubmitClarification requires the clarification mode, at least one choice, and no prior selection", () => {
  assert.equal(
    canSubmitClarification({
      presentationMode: "clarification",
      choiceCount: 2,
      selectedChoiceId: undefined,
    }),
    true
  );
  assert.equal(
    canSubmitClarification({
      presentationMode: "clarification",
      choiceCount: 0,
      selectedChoiceId: undefined,
    }),
    false
  );
  assert.equal(
    canSubmitClarification({
      presentationMode: "clarification",
      choiceCount: 2,
      selectedChoiceId: "already-picked",
    }),
    false
  );
  assert.equal(
    canSubmitClarification({
      presentationMode: "current_finance",
      choiceCount: 2,
      selectedChoiceId: undefined,
    }),
    false
  );
});

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

test("presentationBadge is null for unset, social, and stable_finance modes", () => {
  assert.equal(presentationBadge(undefined), null);
  assert.equal(presentationBadge("social"), null);
  assert.equal(presentationBadge("stable_finance"), null);
});

test("presentationBadge gives every evidence-sensitive mode a distinct, honest label", () => {
  assert.equal(presentationBadge("clarification")?.label, "Needs one more detail");
  assert.equal(presentationBadge("current_finance")?.label, "Current data");
  assert.equal(presentationBadge("comparison")?.label, "Comparison");
  assert.equal(presentationBadge("limited_evidence")?.label, "Limited evidence");
  assert.equal(presentationBadge("no_evidence")?.label, "No verified evidence");
  assert.equal(presentationBadge("deep_pending")?.label, "Researching deeper");
  assert.equal(presentationBadge("deep_failed")?.label, "Deeper research paused");
});

test("presentationAccentClass is empty for unset/social and non-empty for every other mode", () => {
  assert.equal(presentationAccentClass(undefined), "");
  assert.equal(presentationAccentClass("social"), "");
  for (const mode of [
    "clarification",
    "stable_finance",
    "current_finance",
    "comparison",
    "limited_evidence",
    "no_evidence",
    "deep_pending",
    "deep_failed",
  ] as const) {
    assert.ok(presentationAccentClass(mode).length > 0, `expected an accent for ${mode}`);
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
});

test("nextDeepAction blocks duplicate clicks while pending or already succeeded", () => {
  assert.equal(nextDeepAction("pending"), "blocked");
  assert.equal(nextDeepAction("success"), "blocked");
});

test("the badge and accent a message renders both come from the effective mode, not the base mode alone", () => {
  // Mirrors what ChatMessage.tsx actually does: compute the effective mode
  // once, then derive both the badge and the accent from it, so an
  // outstanding/stalled Deep Research pass always overrides the base
  // finance-answer badge instead of only tinting the accent border.
  const effective = effectivePresentationMode("current_finance", "pending");
  assert.equal(effective, "deep_pending");
  assert.equal(presentationBadge(effective)?.label, "Researching deeper");
  assert.equal(presentationAccentClass(effective), "border-sky-400/50");

  const failedEffective = effectivePresentationMode("comparison", "failure");
  assert.equal(failedEffective, "deep_failed");
  assert.equal(
    presentationBadge(failedEffective)?.label,
    "Deeper research paused"
  );
  assert.equal(presentationAccentClass(failedEffective), "border-rose-400/50");
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

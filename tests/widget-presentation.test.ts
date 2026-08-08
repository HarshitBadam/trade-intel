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

test("presentationBadge hides decorative route labels", () => {
  assert.equal(presentationBadge(undefined), null);
  assert.equal(presentationBadge("social"), null);
  assert.equal(presentationBadge("stable_finance"), null);
  assert.equal(presentationBadge("current_finance"), null);
  assert.equal(presentationBadge("comparison"), null);
});

test("presentationBadge only labels actionable states", () => {
  assert.equal(presentationBadge("clarification")?.label, "Needs one more detail");
  assert.equal(presentationBadge("limited_evidence")?.label, "Partial data");
  assert.equal(presentationBadge("no_evidence")?.label, "Data unavailable");
  assert.equal(presentationBadge("deep_pending")?.label, "Researching deeper");
  assert.equal(presentationBadge("deep_failed")?.label, "Research unavailable");
});

test("presentationAccentClass only accents actionable states", () => {
  assert.equal(presentationAccentClass(undefined), "");
  assert.equal(presentationAccentClass("social"), "");
  assert.equal(presentationAccentClass("stable_finance"), "");
  assert.equal(presentationAccentClass("current_finance"), "");
  assert.equal(presentationAccentClass("comparison"), "");
  for (const mode of [
    "clarification",
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
  assert.equal(nextDeepAction("failure", false), "blocked");
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
    "Research unavailable"
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

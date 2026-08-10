/**
 * Pure widget-presentation helpers. These translate the engine's stable
 * `ChatPresentationMode` (plus local Deep Research state) into restrained,
 * distinct visual treatment. Kept free of React so the mapping is directly
 * testable and reusable between `ChatMessage.tsx` and any future surface.
 */
import type { ChatPresentationMode } from "@/lib/stocksage/types";
import type { DeepMessageState } from "./ChatMessage";

export type PresentationBadge = { label: string; toneClass: string };

/**
 * Presentation modes remain available for behavior, accents, and telemetry,
 * but user-facing status badges are deliberately disabled in every environment.
 */
export function presentationBadge(
  _mode: ChatPresentationMode | undefined
): PresentationBadge | null {
  return null;
}

/** Internal modes never alter the visible answer container. */
export function presentationAccentClass(
  _mode: ChatPresentationMode | undefined
): string {
  return "";
}

/**
 * Deep Research state takes precedence over the base mode for the overall
 * message accent: a message is presented as `deep_pending`/`deep_failed`
 * while that work is outstanding or has stalled, without losing the base
 * mode used to badge the regular answer itself.
 */
export function effectivePresentationMode(
  base: ChatPresentationMode | undefined,
  deepStatus: DeepMessageState["status"] | undefined
): ChatPresentationMode | undefined {
  if (deepStatus === "pending") return "deep_pending";
  if (deepStatus === "failure") return "deep_failed";
  return base;
}

/**
 * Whether a Deep Research click should start a first attempt, retry with a
 * fresh signed attempt identity, or be ignored because work is already in
 * flight or already succeeded.
 */
export function nextDeepAction(
  status: DeepMessageState["status"] | undefined,
  retryable: boolean | undefined = true
): "start" | "retry" | "blocked" {
  if (status === undefined || status === "idle") return "start";
  if (status === "failure") return retryable === false ? "blocked" : "retry";
  return "blocked";
}

/** A clarification message can still be answered: it has choices and none is selected yet. */
export function canSubmitClarification(args: {
  presentationMode: ChatPresentationMode | undefined;
  choiceCount: number;
  selectedChoiceId: string | undefined;
}): boolean {
  return (
    args.presentationMode === "clarification" &&
    args.choiceCount > 0 &&
    !args.selectedChoiceId
  );
}

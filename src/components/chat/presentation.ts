/**
 * Pure widget-presentation helpers. These translate the engine's stable
 * `ChatPresentationMode` (plus local Deep Research state) into restrained,
 * distinct visual treatment. Kept free of React so the mapping is directly
 * testable and reusable between `ChatMessage.tsx` and any future surface.
 */
import type { ChatPresentationMode } from "@/lib/stocksage/types";
import type { DeepMessageState } from "./ChatMessage";

export type PresentationBadge = { label: string; toneClass: string };

const BADGES: Partial<Record<ChatPresentationMode, PresentationBadge>> = {
  clarification: {
    label: "Needs one more detail",
    toneClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  current_finance: {
    label: "Current data",
    toneClass: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  comparison: {
    label: "Comparison",
    toneClass: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  limited_evidence: {
    label: "Limited evidence",
    toneClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  no_evidence: {
    label: "No verified evidence",
    toneClass: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  deep_pending: {
    label: "Researching deeper",
    toneClass: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  deep_failed: {
    label: "Deeper research paused",
    toneClass: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
};

/**
 * The small text badge for a presentation mode, or `null` when the mode is
 * either unset (legacy replies) or one that reads fine without extra copy
 * (`social`, `stable_finance`) — restrained means not every mode needs a label.
 */
export function presentationBadge(
  mode: ChatPresentationMode | undefined
): PresentationBadge | null {
  if (!mode) return null;
  return BADGES[mode] ?? null;
}

const ACCENTS: Partial<Record<ChatPresentationMode, string>> = {
  clarification: "border-amber-400/70",
  current_finance: "border-sky-400/50",
  comparison: "border-violet-400/50",
  limited_evidence: "border-amber-400/50",
  no_evidence: "border-rose-400/50",
  deep_pending: "border-sky-400/50",
  deep_failed: "border-rose-400/50",
  stable_finance: "border-emerald-400/40",
};

/** Thin left-border accent color per mode; empty string when no accent applies. */
export function presentationAccentClass(
  mode: ChatPresentationMode | undefined
): string {
  if (!mode) return "";
  return ACCENTS[mode] ?? "";
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
  status: DeepMessageState["status"] | undefined
): "start" | "retry" | "blocked" {
  if (status === undefined || status === "idle") return "start";
  if (status === "failure") return "retry";
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

import "server-only";

import { randomUUID } from "node:crypto";
import type { RequestBudget } from "./budget";
import type { RetrievalProviders } from "./evidence/retrieve";
import type {
  GreenfieldDependencies,
  GreenfieldReply,
} from "./greenfield/engine";
import type { SimpleRuntimeDependencies } from "./simple-runtime";
import type { SafetyClassifier } from "./safety-classifier";
import { logStockSage } from "./telemetry";
import type {
  ChatDataStatus,
  ChatPresentationMode,
  ChatReply,
  ClarificationChoice,
  ConversationState,
  Turn,
  TurnDecision,
} from "./types";

export type ChatDependencies = {
  retrievalProviders?: RetrievalProviders;
  safetyClassifier?: SafetyClassifier;
  /**
   * Explicit per-request rollout override for tests and benchmarks. A v2
   * conversation remains greenfield even when this asks for legacy.
   */
  engine?: "legacy" | "greenfield" | "simple";
  /** Greenfield provider seams; production normally leaves this undefined. */
  greenfield?: GreenfieldDependencies;
  /** Simple-runtime provider/model seams; production normally leaves this undefined. */
  simple?: SimpleRuntimeDependencies;
  /** Test seam for Deep Research queue capability; production uses config. */
  deepQueueReady?: boolean;
  /** Per-request benchmark/diagnostic observer; never affects publication. */
  onGreenfieldReply?: (reply: GreenfieldReply) => void;
  /**
   * Test-only observer for the authoritative, frozen turn. Kept per request
   * so concurrent tests cannot share mutable observation state.
   */
  onTurnFinalized?: (turn: Turn) => void;
  /**
   * Test-only observer invoked when the single answer executor receives the
   * turn. Instant replies intentionally never invoke it.
   */
  onAnswerExecution?: (turn: Turn) => void;
  /** Test-only observer for the measured retrieval wall-clock duration. */
  onRetrievalComplete?: (retrievalMs: number) => void;
  /**
   * Test-only observation seam: invoked once, synchronously, whenever the
   * unified answer executor (`answer.ts`) enters its synthesis stage for
   * this request. Production code never sets this. Because it is supplied
   * per request through `ChatDependencies` rather than kept as module
   * state, concurrent production or test requests can never share or race
   * on a synthesis counter.
   */
  onSynthesisAttempt?: () => void;
};

/**
 * Deterministic mapping from a frozen turn decision plus the data status of
 * what was actually published to one of the widget's stable presentation
 * modes. Pure and total: the same (kind, route, dataStatus) triple always
 * maps to the same mode. Kinds outside the finance-answer surface (safety
 * refusals, crisis, out-of-scope, high-stakes, prohibited) intentionally
 * return `undefined` — the widget already renders those from `route`/`text`
 * and does not need a presentation mode for them.
 */
export function presentationModeFor(
  decision: Pick<TurnDecision, "kind" | "route">,
  dataStatus: ChatDataStatus
): ChatPresentationMode | undefined {
  if (decision.kind === "social") return "social";
  if (decision.kind === "ambiguous") return "clarification";
  const isFinanceAnswer =
    decision.kind === "supported_stable" ||
    decision.kind === "supported_current" ||
    decision.kind === "supported_comparison";
  if (!isFinanceAnswer) return undefined;
  if (dataStatus === "unavailable") return "no_evidence";
  if (dataStatus === "limited") return "limited_evidence";
  if (decision.kind === "supported_comparison" || decision.route === "comparison") {
    return "comparison";
  }
  if (decision.kind === "supported_current" || decision.route === "current_finance") {
    return "current_finance";
  }
  return "stable_finance";
}

/**
 * Structured choices for clarification reason codes with a known, finite
 * set of real next-turn meanings. A choice's `label` is exactly what gets
 * resubmitted as the next user turn, so every label here is written to
 * resolve unambiguously to its intended entities/route on its own —
 * verified in `tests/widget-clarification-choices.test.ts`.
 *
 * Every other clarification (missing companies, stale former/latter
 * references, open-ended entity requests, ...) intentionally has no entry
 * here: the widget must never fabricate a chip whose only "choice" is to
 * resubmit the clarifying question itself. Those turns rely on free text.
 */
const CLARIFICATION_CHOICES: Partial<Record<string, ClarificationChoice[]>> = {
  // Only reachable when the user asks about "the other/another Big Four"
  // with no group already named this turn (see `intent.ts`), so exactly one
  // of these two canonical groups is always the real referent.
  ambiguous_big_four: [
    {
      id: "australian-big-four",
      label: "The Australian Big Four banks (CBA, NAB, ANZ, WBC)",
    },
    {
      id: "professional-services-big-four",
      label: "The professional services Big Four (Deloitte, PwC, EY, KPMG)",
    },
  ],
  // Each label names both "crypto" and one finance-context keyword so the
  // resubmitted turn passes `CRYPTO_FINANCE_CONTEXT` on its own, standing
  // alone from conversation history.
  ambiguous_crypto: [
    { id: "crypto_market_risk", label: "Crypto market risk" },
    { id: "crypto_regulatory_risk", label: "Crypto regulatory risk" },
    { id: "crypto_business_risk", label: "Crypto business risk" },
    { id: "crypto_portfolio_risk", label: "Crypto portfolio risk" },
  ],
};

/**
 * Real, actionable choices for a clarification reason code, or `undefined`
 * when no finite set of meanings exists. Pure and total: callers must never
 * synthesize a fallback chip from the clarification prose itself, since
 * resubmitting the whole question back is not a choice.
 */
export function clarificationChoicesFor(
  reasonCode: string
): ClarificationChoice[] | undefined {
  return CLARIFICATION_CHOICES[reasonCode];
}

/** Frozen classification handed to an executor; never re-derived downstream. */
export type ExecutorOptions = {
  turn?: Turn;
  budget?: RequestBudget;
};

export {
  ACUTE_DISTRESS_RESPONSE,
  SELF_HARM_RESPONSE,
} from "./crisis";

export const PROHIBITED_FALLBACK =
  "I can’t help with that. I can help analyze markets, listed companies, and investment risk.";

export function immediateResponse(args: {
  text: string;
  state: ConversationState;
  route: string;
  reasonCode: string;
  startedAt: number;
  retryable?: boolean;
  dataStatus?: ChatDataStatus;
  decision?: TurnDecision;
  presentationMode?: ChatPresentationMode;
  presentationReason?: string;
  clarificationChoices?: ClarificationChoice[];
}): ChatReply {
  logStockSage({
    event: "request_complete",
    route: args.route,
    reasonCode: args.reasonCode,
    durationMs: Date.now() - args.startedAt,
    providerCount: 0,
    ...(args.decision
      ? {
          decisionKind: args.decision.kind,
          routeClass: args.decision.routeClass,
          latencyClass: args.decision.latencyClass,
          deepEligible: args.decision.deepEligible,
          retryVisible: args.decision.retryEligible,
        }
      : { latencyClass: "instant" as const }),
  });
  return {
    text: args.text,
    live: false,
    kind: "answer",
    responseId: randomUUID(),
    state: args.state,
    dataStatus: args.dataStatus ?? "full",
    ...(args.retryable !== undefined ? { retryable: args.retryable } : {}),
    ...(args.presentationMode !== undefined
      ? {
          presentationMode: args.presentationMode,
          presentationReason: args.presentationReason ?? args.reasonCode,
        }
      : {}),
    ...(args.clarificationChoices !== undefined
      ? { clarificationChoices: args.clarificationChoices }
      : {}),
  };
}

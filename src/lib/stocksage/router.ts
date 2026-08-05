import { buildTurnContext, resolveTurnContext } from "./context";
import {
  crisisResponse,
  detectCrisis,
} from "./crisis";
import type { StateResolution } from "./entities";
import {
  immediateReply,
  normalizeMessage,
  routeMessage,
  STABLE_FINANCE,
} from "./intent";
import {
  classifyHighStakes,
  evaluateDomainPolicy,
  hardSafetyFloor,
  pickHighStakesReply,
} from "./policy";
import { creativeRequestOnly } from "./regular-guards";
import type {
  ChatRequest,
  ChatRoute,
  ConversationState,
  FinanceEntity,
  Turn,
  TurnDecision,
  TurnDecisionKind,
} from "./types";

/** "What is a P/E ratio?" stays a concept answer even beside a named company. */
const DEFINITIONAL =
  /\b(?:what (?:is|are|does)\s+(?:an?|the)\b|what'?s\s+(?:an?|the)\b|explain|define|definition of|how (?:does|do)\s+(?:an?|the)\b|mean by)\b/i;

const SAFETY_SUPPORT_CODES = new Set([
  "explicit_self_harm",
  "acute_distress",
  "threat_of_violence",
]);

function decision(
  value: Omit<TurnDecision, "version"> & { version?: 1 }
): TurnDecision {
  return Object.freeze({ ...value, version: 1 } as TurnDecision);
}

function instant(args: {
  kind: TurnDecisionKind;
  route: ChatRoute;
  reasonCode: string;
  text?: string;
  clarification?: string;
  retryEligible?: boolean;
  safetyRailRequired?: boolean;
}): TurnDecision {
  return decision({
    kind: args.kind,
    route: args.route,
    reasonCode: args.reasonCode,
    safetyRailRequired: args.safetyRailRequired ?? true,
    latencyClass: "instant",
    routeClass:
      args.kind === "safety_support"
        ? "instant_safety"
        : args.kind === "social"
          ? "instant_social"
          : args.kind === "ambiguous"
            ? "instant_clarify"
            : "instant_refusal",
    retrievalAuthorized: false,
    synthesisAuthorized: false,
    deepEligible: false,
    retryEligible: args.retryEligible ?? false,
    ...(args.text !== undefined ? { immediateText: args.text } : {}),
    ...(args.clarification !== undefined
      ? { clarification: args.clarification }
      : {}),
  });
}

function supported(args: {
  kind: Extract<
    TurnDecisionKind,
    "supported_stable" | "supported_current" | "supported_comparison"
  >;
  route: ChatRoute;
  reasonCode: string;
  retrievalAuthorized: boolean;
}): TurnDecision {
  return decision({
    kind: args.kind,
    route: args.route,
    reasonCode: args.reasonCode,
    safetyRailRequired: true,
    latencyClass: "regular",
    routeClass: args.retrievalAuthorized ? "retrieval" : "instant_clarify",
    retrievalAuthorized: args.retrievalAuthorized,
    synthesisAuthorized: true,
    deepEligible: args.retrievalAuthorized,
    retryEligible: true,
  });
}

function australianListingClarification(
  message: string,
  entities: FinanceEntity[]
): string | null {
  const entity = entities.find(
    (candidate) =>
      candidate.market === "au" || candidate.jurisdiction === "Australia"
  );
  if (
    !entity ||
    !/\b(?:australia|australian|aussie|asx|home listing|primary listing|underlying listing)\b/i.test(
      message
    ) ||
    !/\b(?:actually|i mean|not|is aussie|is australian|it'?s aussie|it is australian|home listing|primary listing|underlying listing)\b/i.test(
      message
    )
  ) {
    return null;
  }
  const listing = entity.ticker ? `ASX:${entity.ticker}` : "its ASX listing";
  return `Yes — ${entity.name} is Australian and its primary listing is ${listing}. The displayed market figure is for the clearly labelled U.S. ADR; ADR and ASX returns can differ, so each instrument stays explicitly identified. Business and reporting analysis remains anchored to ${entity.name}.`;
}

const PROHIBITED_FALLBACK_ROUTE: ChatRoute = "refused";

/**
 * The one place a turn is classified. Executors receive the frozen result and
 * must not re-derive route, entities, retrieval authorization or safety.
 * Entity/group/listing/temporal resolution itself lives in `./context`; this
 * module only owns the policy and routing decisions built on top of it.
 */
export function decideTurn(
  request: ChatRequest,
  options: { now?: Date; baseState?: ConversationState } = {}
): Turn {
  const message = normalizeMessage(request.message);

  const crisis = detectCrisis(message);
  if (crisis) {
    const resolution: StateResolution = {
      state: options.baseState ?? {
        version: 1,
        revision: 0,
        entities: [],
        explicitEntitySet: [],
        criteria: [],
      },
      entities: [],
      reasonCode: "crisis_short_circuit",
    };
    return {
      decision: instant({
        kind: "safety_support",
        route: "safety_support",
        reasonCode:
          crisis === "self_harm"
            ? "explicit_self_harm_language"
            : "acute_distress_language",
        text: crisisResponse(crisis),
        safetyRailRequired: false,
      }),
      context: buildTurnContext({
        message,
        resolution,
        entities: [],
        now: options.now,
      }),
    };
  }

  const scoped: ChatRequest = { ...request, message };
  const {
    context,
    resolution,
    effectiveEntities,
    policyEntities,
    conversationReference,
  } = resolveTurnContext({ message, request: scoped, now: options.now });

  const floor = hardSafetyFloor(message, policyEntities);
  if (floor?.response) {
    const highStakes =
      floor.reasonCode === "high_stakes_finance"
        ? classifyHighStakes(message, policyEntities)
        : null;
    const picked = highStakes
      ? pickHighStakesReply(highStakes, resolution.state.safetyRepliesUsed ?? [])
      : null;
    const safety = SAFETY_SUPPORT_CODES.has(floor.reasonCode);
    return {
      decision: instant({
        kind: safety
          ? "safety_support"
          : highStakes
            ? "high_stakes_finance"
            : "prohibited",
        route: safety ? "safety_support" : PROHIBITED_FALLBACK_ROUTE,
        reasonCode: floor.reasonCode,
        text: picked?.text ?? floor.response,
        safetyRailRequired: false,
      }),
      context: picked
        ? {
            ...context,
            state: {
              ...context.state,
              safetyRepliesUsed: [
                ...(context.state.safetyRepliesUsed ?? []),
                picked.id,
              ].slice(-24),
            },
          }
        : context,
    };
  }

  const listing = australianListingClarification(message, policyEntities);
  if (listing) {
    return {
      decision: instant({
        kind: "supported_current",
        route: "current_finance",
        reasonCode: "australian_listing_clarified",
        text: listing,
        safetyRailRequired: false,
      }),
      context,
    };
  }

  if (creativeRequestOnly(message)) {
    const policy = evaluateDomainPolicy(message, []);
    return {
      decision: instant({
        kind: "out_of_scope",
        route: "out_of_scope",
        reasonCode: "out_of_scope",
        text:
          policy.response ??
          "I stick to financial markets and company research, so I can’t write the creative piece.",
        safetyRailRequired: false,
      }),
      context,
    };
  }

  // The social gate runs ahead of the domain policy so a turn like "you're a
  // useless bot" answers conversationally instead of as out-of-scope.
  const socialRoute = routeMessage({
    message,
    entities: resolution.entities,
    state: resolution.state,
    clarification: resolution.clarification,
  });
  if (socialRoute.route === "social") {
    const text = immediateReply(socialRoute, message);
    if (text) {
      return {
        decision: instant({
          kind: "social",
          route: "social",
          reasonCode: socialRoute.reasonCode,
          text,
        }),
        context,
      };
    }
  }

  if (resolution.clarification) {
    return {
      decision: instant({
        kind: "ambiguous",
        route: "clarify",
        reasonCode: resolution.reasonCode,
        text: resolution.clarification,
        clarification: resolution.clarification,
      }),
      context,
    };
  }

  const policyView =
    resolution.reasonCode === "no_entities" && !conversationReference
      ? []
      : effectiveEntities;
  const policy = evaluateDomainPolicy(message, policyView);
  const inheritsScope =
    policy.reasonCode === "out_of_scope" &&
    request.history.length > 0 &&
    conversationReference;
  if (policy.action !== "allow" && !inheritsScope) {
    const clarify = policy.action === "clarify";
    return {
      decision: instant({
        kind: clarify
          ? "ambiguous"
          : policy.reasonCode === "out_of_scope"
            ? "out_of_scope"
            : "prohibited",
        route: clarify
          ? "clarify"
          : policy.reasonCode === "out_of_scope"
            ? "out_of_scope"
            : PROHIBITED_FALLBACK_ROUTE,
        reasonCode: policy.reasonCode,
        text: policy.response ?? "Please ask a financial-market question.",
        ...(clarify ? { clarification: policy.response } : {}),
      }),
      context,
    };
  }

  const route = routeMessage({
    message,
    entities: effectiveEntities,
    state: resolution.state,
    clarification: resolution.clarification,
  });
  const immediate = immediateReply(route, message);
  if (immediate) {
    return {
      decision: instant({
        kind:
          route.route === "social"
            ? "social"
            : route.route === "safety_support"
              ? "safety_support"
              : "ambiguous",
        route: route.route,
        reasonCode: route.reasonCode,
        text: immediate,
        ...(route.clarification ? { clarification: route.clarification } : {}),
      }),
      context,
    };
  }

  if (route.route === "comparison") {
    return {
      decision: supported({
        kind: "supported_comparison",
        route: "comparison",
        reasonCode: route.reasonCode,
        retrievalAuthorized: true,
      }),
      context,
    };
  }
  if (route.route === "current_finance") {
    return {
      decision: supported({
        kind: "supported_current",
        route: "current_finance",
        reasonCode: route.reasonCode,
        retrievalAuthorized: true,
      }),
      context,
    };
  }
  // The router calls a turn stable whenever an entity is named, even when the
  // question raises no stable concept at all. "What about Macquarie?" is a
  // question about that company now, so it has to reach evidence.
  // A follow-up that inherits its subject is asking about the live situation
  // ("what risks should I research first?"), even though it names a concept.
  const inheritedSubject =
    resolution.entities.length === 0 && effectiveEntities.length > 0;
  if (
    route.route === "stable_finance" &&
    effectiveEntities.length > 0 &&
    (inheritedSubject || !STABLE_FINANCE.test(message)) &&
    !DEFINITIONAL.test(message)
  ) {
    return {
      decision: supported({
        kind:
          effectiveEntities.length >= 2
            ? "supported_comparison"
            : "supported_current",
        route: effectiveEntities.length >= 2 ? "comparison" : "current_finance",
        reasonCode: "named_subject_requires_evidence",
        retrievalAuthorized: true,
      }),
      context,
    };
  }
  if (route.route === "general") {
    return {
      decision: decision({
        kind: "supported_stable",
        route: "general",
        reasonCode: route.reasonCode,
        safetyRailRequired: true,
        latencyClass: "regular",
        routeClass: "instant_clarify",
        retrievalAuthorized: false,
        synthesisAuthorized: true,
        deepEligible: false,
        retryEligible: true,
      }),
      context,
    };
  }
  return {
    decision: supported({
      kind: "supported_stable",
      route: "stable_finance",
      reasonCode: route.reasonCode,
      retrievalAuthorized: false,
    }),
    context,
  };
}

export function isInstantDecision(value: TurnDecision): boolean {
  return value.latencyClass === "instant" && value.immediateText !== undefined;
}

import {
  ACUTE_DISTRESS_RESPONSE,
  detectCrisis,
  SELF_HARM_RESPONSE,
} from "./crisis";
import {
  ABUSE_AT_BOT,
  CASUAL_ACKNOWLEDGEMENT,
  CASUAL_OPENING,
  FAREWELL,
  FRUSTRATION,
  HELP,
  SOCIAL,
} from "./social-patterns";
import type {
  ConversationState,
  FinanceEntity,
  RouteDecision,
} from "./types";
const COMPARISON =
  /\b(?:compare|comapre|comparison|rank|ranking|order|big\s*(?:4|four)|versus|vs\.?|better (?:stock|investment)|which (?:one|company|stock)|relative to|against)\b/i;
const TIME_SENSITIVE =
  /\b(?:latest|now|current|currently|news|update|developments?|catalysts?|what\b.{0,50}\bmatters?|earnings|guidance|(?:is|are)\b.{0,60}\b(?:public|private|listed)|public\s*\/\s*private status|publicly traded|(?:stock|share) price|trading at|market move|what (?:changed|happened|moved)|what(?:'?s(?: is)?| is) up with|how (?:is|are|did|has|have|was|were)\b.{0,80}\b(?:doing|doin|done|performing|moved|changed)|recover|bounce back|turn around|do (?:well|good) again|anything notable|market conditions?|legal|lawsuit|regulatory|regulator)\b/i;
const MOVE_CAUSE =
  /\b(?:why\b.{0,80}\b(?:up|down|higher|lower|rising|falling|rose|fell|rall(?:y|ied)|drop(?:ped)?|selloff)|what\b.{0,50}\b(?:moved|drove|caused|is moving)|reason\b.{0,40}\b(?:move|rise|fall|rally|drop|selloff))\b/i;
const FORWARD_RESEARCH =
  /\b(?:next (?:week|month|quarter|year)|what should (?:i|we|investors?) watch)\b/i;
const SELF_HISTORY_COMPARISON =
  /\bcompar(?:e|ed|ing)\b.{0,50}\b(?:with|to)\s+(?:its|their|the compan(?:y|ies)'?)\s+(?:own\s+)?history\b/i;
const RESEARCH_SUMMARY_FOLLOW_UP =
  /\b(?:summari[sz]e|recap|bottom line|trade-offs?)\b/i;
const CODE =
  /\b(?:python|javascript|typescript|java|c\+\+|code|script|function|loop|syntax|compile|runtime|output|console\.log|print\s*\(|for\s+\w+\s+in\s+range)\b/i;
export const STABLE_FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|dividend|market cap|capitalisation|stock|share|bond|etf|interest rate|inflation|gdp|recession|earnings per share|eps|cash flow|balance sheet|valuation|risks?|fraud|market manipulation|public compan|portfolio|finance|financial|investors?|invest)\b/i;
export { detectCrisis } from "./crisis";
export type { CrisisKind } from "./crisis";
const CURRENT_GENERAL =
  /\b(?:fed|federal reserve|rates?|inflation|economy|market|asx|nasdaq|s&p|dow)\b/i;

export function normalizeMessage(message: string): string {
  return message.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function isMoveCauseAsk(message: string): boolean {
  return MOVE_CAUSE.test(normalizeMessage(message));
}

export function routeMessage(args: {
  message: string;
  entities: FinanceEntity[];
  state: ConversationState;
  clarification?: string;
  /** Supplied only by the authoritative temporal compiler. */
  hasTemporalIntent?: boolean;
}): RouteDecision {
  const text = normalizeMessage(args.message);
  if (args.clarification) {
    return {
      route: "clarify",
      reasonCode: "reference_needs_clarification",
      retrievalRequired: false,
      deepEligible: false,
      clarification: args.clarification,
    };
  }
  const crisis = detectCrisis(text);
  if (crisis) {
    return {
      route: "safety_support",
      reasonCode:
        crisis === "self_harm"
          ? "explicit_self_harm_language"
          : "acute_distress_language",
      retrievalRequired: false,
      deepEligible: false,
    };
  }
  if (
    SOCIAL.test(text) ||
    (args.entities.length === 0 &&
      CASUAL_OPENING.test(text) &&
      !CODE.test(text) &&
      !STABLE_FINANCE.test(text) &&
      !CURRENT_GENERAL.test(text) &&
      !TIME_SENSITIVE.test(text)) ||
    (/^(?:hello|hey|hi)\b/i.test(text) &&
      /\b(?:greet|welcome)\b/i.test(text) &&
      !CODE.test(text)) ||
    FAREWELL.test(text) ||
    HELP.test(text) ||
    CASUAL_ACKNOWLEDGEMENT.test(text) ||
    FRUSTRATION.test(text) ||
    ABUSE_AT_BOT.test(text)
  ) {
    return {
      route: "social",
      reasonCode: HELP.test(text) ? "help" : "social",
      retrievalRequired: false,
      deepEligible: false,
    };
  }
  if (
    args.entities.length === 0 &&
    /\b(?:other|another)\s+big\s*(?:4|four)\b/i.test(text)
  ) {
    return {
      route: "clarify",
      reasonCode: "ambiguous_big_four",
      retrievalRequired: false,
      deepEligible: false,
      clarification:
        "Do you mean the Australian Big Four banks (CBA, NAB, ANZ, WBC), or the professional services Big Four (Deloitte, PwC, EY, KPMG)?",
    };
  }
  if (CODE.test(text)) {
    return {
      route: "general",
      reasonCode: "clear_code_or_general",
      retrievalRequired: false,
      deepEligible: false,
    };
  }
  if (
    args.entities.length === 1 &&
    /^Fortune (?:100|500)$/.test(args.entities[0].name) &&
    /\b(?:fortune|rank|ranking|top|who|list|revenue)\b/i.test(text)
  ) {
    return {
      route: "current_finance",
      reasonCode: "current_claim_requires_evidence",
      retrievalRequired: true,
      deepEligible: true,
    };
  }
  if (
    args.entities.length === 1 &&
    SELF_HISTORY_COMPARISON.test(text)
  ) {
    return {
      route: "current_finance",
      reasonCode: "current_claim_requires_evidence",
      retrievalRequired: true,
      deepEligible: true,
    };
  }
  if (
    COMPARISON.test(text) ||
    (args.entities.length >= 2 &&
      args.state.explicitEntitySet.length >= 2 &&
      (args.hasTemporalIntent ||
        /\b(?:which (?:one|is)|what about|how about|better|safer|less risky|more risky|rank|order|all of them|former two|latter two)\b/i.test(
          text
        ))) ||
    (/\b(?:wb|what about)\s+(?:the\s+)?100\b/i.test(text) &&
      args.state.explicitEntitySet.length === 2)
  ) {
    if (args.entities.length < 2) {
      return {
        route: "clarify",
        reasonCode: "comparison_missing_entities",
        retrievalRequired: false,
        deepEligible: false,
        clarification:
          "Which companies or investments would you like me to compare?",
      };
    }
    return {
      route: "comparison",
      reasonCode: "explicit_comparison",
      retrievalRequired: true,
      deepEligible: true,
    };
  }
  if (
    ((args.hasTemporalIntent ||
      TIME_SENSITIVE.test(text) ||
      isMoveCauseAsk(text) ||
      FORWARD_RESEARCH.test(text)) &&
      (args.entities.length > 0 || CURRENT_GENERAL.test(text))) ||
    (args.entities.length > 0 &&
      args.state.criteria.length > 0 &&
      RESEARCH_SUMMARY_FOLLOW_UP.test(text)) ||
    (args.entities.some((entity) =>
      /^Fortune (?:100|500)$/.test(entity.name)
    ) &&
      /\b(?:wb|what about|who|top|rank|ranking|revenue|list)\b/i.test(text))
  ) {
    return {
      route: "current_finance",
      reasonCode: "current_claim_requires_evidence",
      retrievalRequired: true,
      deepEligible: true,
    };
  }
  if (
    args.entities.length === 0 &&
    /\b(?:listed|public)\b.*\b(?:operator|company)\b/i.test(text) &&
    /\b(?:analy[sz]e|earnings|financial performance|valuation|outlook|revenue)\b/i.test(
      text
    )
  ) {
    return {
      route: "clarify",
      reasonCode: "company_name_required",
      retrievalRequired: false,
      deepEligible: false,
      clarification:
        "Which listed company or operator should I analyze?",
    };
  }
  if (args.entities.length > 0 || STABLE_FINANCE.test(text)) {
    return {
      route: "stable_finance",
      reasonCode: "stable_finance_no_retrieval",
      retrievalRequired: false,
      deepEligible: false,
    };
  }
  return {
    route: "general",
    reasonCode: "off_topic_or_general",
    retrievalRequired: false,
    deepEligible: false,
  };
}

export function immediateReply(
  decision: RouteDecision,
  message: string
): string | null {
  if (decision.route === "clarify") {
    return decision.clarification ?? "Could you clarify what you mean?";
  }
  if (decision.route === "safety_support") {
    return decision.reasonCode === "acute_distress_language"
      ? ACUTE_DISTRESS_RESPONSE
      : SELF_HARM_RESPONSE;
  }
  if (decision.route !== "social") return null;
  if (HELP.test(message)) {
    return "I can explain finance concepts, check current market data, compare companies or investments, and follow a topic across the conversation. For supported current questions, you can also use Research deeper.";
  }
  if (ABUSE_AT_BOT.test(message)) {
    return "Fair enough, I didn’t earn a medal on that one. Give me another shot, what do you want to look at?";
  }
  if (FRUSTRATION.test(message)) {
    return "Yeah, fair, that was frustrating. Want to retry the last market question or switch topics?";
  }
  if (FAREWELL.test(message)) {
    const farewells = [
      "Catch you next time, stay sharp out there.",
      "Take it easy, the charts will keep till you're back.",
      "Sayonara for now, go enjoy the real world for a bit.",
      "Later! It was a good session, see you around.",
      "All the best out there. I'll hold the fort.",
      "Go well, and may your entries be timely.",
    ];
    return farewells[Math.floor(Math.random() * farewells.length)];
  }
  if (
    /thx|thank|cheers|appreciated|that (?:was|is)(?: actually| really)? helpful|that helps|got it/i.test(
      message
    )
  ) {
    return /got it|gotcha/i.test(message)
      ? "Got it. What should we look at next?"
      : "Anytime. Want to look at anything else?";
  }
  if (/\b(?:aight|gucci|all good)\b/i.test(message)) {
    return "All good. Give me a shout when you want to look at something.";
  }
  if (/\bwe good\b/i.test(message)) {
    return "We’re good, no stress.";
  }
  if (/i'?m back|hey again/i.test(message)) {
    return "Welcome back. What are we digging into?";
  }
  if (/^(?:sup|yo)\b|what'?s (?:up|good|new)/i.test(message)) {
    return "Hey, what are we looking at?";
  }
  return "Hey! What are you looking into?";
}

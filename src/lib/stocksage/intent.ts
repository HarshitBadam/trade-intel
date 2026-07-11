import type {
  ChatRoute,
  ConversationState,
  FinanceEntity,
  RouteDecision,
} from "./types";

const SOCIAL =
  /^(?:(?:hey|hi|hello|hiya|howdy|sup|g'?day|good\s+(?:morning|afternoon|evening))(?:\s+again)?(?:,\s*i'?m back)?(?:\s+(?:boss|bro|mate|dude|there|sage|stocksage))?|i'?m back|how are you|how'?s it going|what'?s up|nice to meet you|aight(?:\s+gucci)?(?:\s+then)?|cool|sounds good|okay|ok|thanks|thank you|cheers|much appreciated|that helps|got it|gotcha)[\s,.!?…-]*$/i;
const FAREWELL =
  /^(?:bye|goodbye|see you)(?:[\s,]+(?:for now|later|soon|again|then|boss|bro|mate|dude|thanks|thank you))*[\s,.!?…-]*$/i;
const HELP =
  /^(?:help|help me|what can you(?: actually)? (?:do|help me with)|how can you help|how do i use (?:this|stocksage)|what should i ask)[\s,.!?…-]*$/i;
const COMPARISON =
  /\b(?:compare|comapre|comparison|versus|vs\.?|better (?:stock|investment)|which (?:one|company|stock)|relative to|against)\b/i;
const TIME_SENSITIVE =
  /\b(?:latest|today|yesterday|now|current|currently|recent|news|update|earnings|guidance|this (?:week|month|quarter|year)|last (?:week|month|quarter|year)|(?:past|last|over) \d+ (?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|(?:stock|share) price|trading at|market move|what happened|what(?:'?s(?: is)?| is) up with|how (?:is|are)\b.{0,80}\b(?:doing|performing)|market conditions?|legal|lawsuit|regulatory|regulator)\b/i;
const CODE =
  /\b(?:python|javascript|typescript|java|c\+\+|code|script|function|loop|syntax|compile|runtime|output|console\.log|print\s*\(|for\s+\w+\s+in\s+range)\b/i;
const STABLE_FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|dividend|market cap|capitalisation|stock|share|bond|etf|interest rate|inflation|gdp|recession|earnings per share|eps|cash flow|balance sheet|valuation|portfolio|finance|financial|invest)\b/i;
const EXPLICIT_SELF_HARM =
  /\b(?:kill myself|end my life|want to die|suicid(?:e|al)|hurt myself|self[- ]harm|not worth living)\b/i;
const CURRENT_GENERAL =
  /\b(?:fed|federal reserve|rates?|inflation|economy|market|asx|nasdaq|s&p|dow)\b/i;

export type AmbiguousRouter = (input: {
  message: string;
  entities: FinanceEntity[];
  state: ConversationState;
}) => Promise<ChatRoute | "clarify">;

export function normalizeMessage(message: string): string {
  return message.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function routeMessage(args: {
  message: string;
  entities: FinanceEntity[];
  state: ConversationState;
  clarification?: string;
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
  if (EXPLICIT_SELF_HARM.test(text)) {
    return {
      route: "safety_support",
      reasonCode: "explicit_self_harm_language",
      retrievalRequired: false,
      deepEligible: false,
    };
  }
  if (SOCIAL.test(text) || FAREWELL.test(text) || HELP.test(text)) {
    return {
      route: "social",
    reasonCode: HELP.test(text) ? "help" : "social",
      retrievalRequired: false,
      deepEligible: false,
    };
  }
  if (/\b(?:other|another)\s+big\s*(?:4|four)\b/i.test(text)) {
    return {
      route: "clarify",
      reasonCode: "ambiguous_big_four",
      retrievalRequired: false,
      deepEligible: false,
      clarification:
        "Do you mean the accounting and consulting Big Four—Deloitte, PwC, EY, and KPMG—or another group?",
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
    COMPARISON.test(text) ||
    (args.state.explicitEntitySet.length >= 2 &&
      /\b(?:which (?:one|is)|what about|how about|better|safer|less risky|more risky|yesterday|last (?:week|month|quarter|year)|this (?:week|month|quarter|year)|over (?:the )?last|past \d+|between)\b/i.test(
        text
      )) ||
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
    TIME_SENSITIVE.test(text) &&
    (args.entities.length > 0 || CURRENT_GENERAL.test(text))
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
    /\b(?:listed|public)\b.*\b(?:operator|company)\b/i.test(text)
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
    return "I’m sorry you’re dealing with this. If you may act on thoughts of harming yourself, call local emergency services now. In Australia, Lifeline is available at 13 11 14; elsewhere, contact your local crisis line or emergency number. If you can, tell someone you trust and stay with them.";
  }
  if (decision.route !== "social") return null;
  if (HELP.test(message)) {
    return "I can explain finance concepts, answer general questions, check current market data when needed, compare investments, and deepen eligible answers with Research deeper.";
  }
  if (/thank|cheers|appreciated|that helps|got it/i.test(message)) {
    return "You’re welcome. What else can I help with?";
  }
  if (/bye|goodbye|see you|aight|gucci/i.test(message)) {
    return "See you next time.";
  }
  return "Hey! What can I help you with?";
}

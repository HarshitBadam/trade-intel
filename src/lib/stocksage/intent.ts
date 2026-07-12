import type {
  ChatRoute,
  ConversationState,
  FinanceEntity,
  RouteDecision,
} from "./types";

const SOCIAL =
  /^(?:(?:hey|hi|hello|hiya|howdy|sup|g'?day|good\s+(?:morning|afternoon|evening))(?:\s+again)?(?:,\s*i'?m back)?(?:[,\s]+(?:boss|bro|mate|dude|there|sage|stocksage))?|i'?m back|how are you|how'?s it going(?:[,\s]+(?:boss|bro|mate|dude))?|what'?s up(?:[,\s]+(?:boss|bro|mate|dude))?|nice to meet you|aight(?:\s+gucci)?(?:\s+then)?|cool|sounds good|okay|ok|thx|thanks?(?:,\s*that helps|\s+(?:boss|bro|mate|dude))?|thank you(?:\s+(?:boss|bro|mate|dude))?|cheers(?:\s+(?:boss|bro|mate|dude))?|much appreciated|that helps|got it|gotcha)[\s,.!?…-]*$/i;
const FAREWELL =
  /^(?:bye|goodbye|see you)(?:[\s,]+(?:for now|later|soon|again|then|boss|bro|mate|dude|thanks|thank you))*[\s,.!?…-]*$/i;
const CASUAL_ACKNOWLEDGEMENT =
  /^(?:thx|thanks?|thank you|cheers)(?:\s+(?:boss|bro|mate|dude))?(?:,?\s+that helps)?[\s,.!?…-]*$/i;
const FRUSTRATION =
  /\b(?:fuck|shit|damn)\b.*\b(?:annoying|frustrating|useless|broken)\b/i;
const ABUSE_AT_BOT =
  /\b(?:you'?re?|ur|u r|you)\b.{0,40}\b(?:useless|worthless|garbage|trash|pathetic|stupid|dumb|shit|crap)\b|\b(?:piece of (?:shit|crap)|dumbass|dumb ass)\b.{0,20}\b(?:bot|ai|assistant|app)\b/i;
const HELP =
  /^(?:help|help me|what can you(?: actually)? (?:do|help me with)|how can you help|how do i use (?:this|stocksage)|what should i ask)[\s,.!?…-]*$/i;
const COMPARISON =
  /\b(?:compare|comapre|comparison|rank|ranking|order|big\s*(?:4|four)|versus|vs\.?|better (?:stock|investment)|which (?:one|company|stock)|relative to|against)\b/i;
const TIME_SENSITIVE =
  /\b(?:latest|today|yesterday|now|current|currently|recent|news|update|earnings|guidance|(?:is|are)\b.{0,60}\b(?:public|private|listed)|public\s*\/\s*private status|publicly traded|this (?:week|month|quarter|year)|last (?:few days|week|month|quarter|year)|(?:past|last|over) \d+ (?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|(?:on|since|before|after)\s+\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|(?:stock|share) price|trading at|market move|what (?:changed|happened)|what(?:'?s(?: is)?| is) up with|how (?:is|are|did|has)\b.{0,80}\b(?:doing|performing|moved|changed)|market conditions?|legal|lawsuit|regulatory|regulator)\b/i;
const CODE =
  /\b(?:python|javascript|typescript|java|c\+\+|code|script|function|loop|syntax|compile|runtime|output|console\.log|print\s*\(|for\s+\w+\s+in\s+range)\b/i;
const STABLE_FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|dividend|market cap|capitalisation|stock|share|bond|etf|interest rate|inflation|gdp|recession|earnings per share|eps|cash flow|balance sheet|valuation|risks?|fraud|market manipulation|public compan|portfolio|finance|financial|investors?|invest)\b/i;
export const EXPLICIT_SELF_HARM =
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
  if (
    SOCIAL.test(text) ||
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
    COMPARISON.test(text) ||
    (args.entities.length >= 2 &&
      args.state.explicitEntitySet.length >= 2 &&
      /\b(?:which (?:one|is)|what about|how about|better|safer|less risky|more risky|rank|order|all of them|former two|latter two|today|yesterday|last (?:few days|week|month|quarter|year)|this (?:week|month|quarter|year)|over (?:the )?last|past \d+|between)\b/i.test(
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
    (TIME_SENSITIVE.test(text) &&
      (args.entities.length > 0 || CURRENT_GENERAL.test(text))) ||
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
    return "I’m sorry you’re dealing with this. If you may act on thoughts of harming yourself, call local emergency services now. In Australia, Lifeline is available at 13 11 14; elsewhere, contact your local crisis line or emergency number. If you can, tell someone you trust and stay with them.";
  }
  if (decision.route !== "social") return null;
  if (HELP.test(message)) {
    return "I can explain finance concepts, check current market data, compare companies or investments, and follow a topic across the conversation. For supported current questions, you can also use Research deeper.";
  }
  if (ABUSE_AT_BOT.test(message)) {
    return "Fair enough, I didn’t earn a medal on that one. Give me another shot — what do you want to look at?";
  }
  if (FRUSTRATION.test(message)) {
    return "Yeah, fair—that was frustrating. Want to retry the last market question or switch topics?";
  }
  if (/thx|thank|cheers|appreciated|that helps|got it/i.test(message)) {
    return /got it|gotcha/i.test(message)
      ? "Got it. What should we look at next?"
      : "Anytime. Want to look at anything else?";
  }
  if (/bye|goodbye|see you|aight|gucci/i.test(message)) {
    return "Catch you next time.";
  }
  if (/i'?m back|hey again/i.test(message)) {
    return "Welcome back. What are we digging into?";
  }
  if (/^sup\b/i.test(message)) {
    return "Hey — what are we looking at?";
  }
  return "Hey! What are you looking into?";
}

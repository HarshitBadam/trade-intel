import type { ChatIntent, ChatMode } from "./types";

const GREETING =
  /^(?:hey|hi|hello|hiya|howdy|good\s+(?:morning|afternoon|evening))(?:\s*,?\s*(?:sage|stocksage))?[!.?\s]*$/i;
const PLEASANTRY =
  /^(?:how are you|how's it going|how is it going|nice to meet you|what's up|whats up|bye|goodbye|see you|have a good day|cool|sounds good|okay|ok)(?:\s*,?\s*(?:sage|stocksage))?[!.?\s]*$/i;
const THANKS =
  /^(?:thanks|thank you|cheers|much appreciated|that helps|got it)(?:\s*,?\s*(?:sage|stocksage))?[!.?\s]*$/i;
const HELP =
  /^(?:help|help me|what can you do|how can you help|how do i use (?:this|stocksage)|what should i ask)[!.?\s]*$/i;
const COMPARISON =
  /\b(?:compare|comparison|versus|vs\.?|better (?:stock|investment)|which (?:one|company|stock)|relative to|against|or)\b/i;
const MACRO =
  /\b(?:fed|federal reserve|interest rates?|inflation|gdp|economy|economic|recession|treasur(?:y|ies)|bond yields?|monetary|fiscal|tariffs?|unemployment|central bank|market cycle|what is|how (?:does|do)|explain|why (?:is|are|did|do))\b/i;
const TIME_SENSITIVE =
  /\b(?:latest|today|now|current|recent|news|update|earnings|guidance|this (?:week|month|quarter|year)|(?:stock|share) price|trading at|market move|what happened)\b/i;

export function classifyIntent(
  message: string,
  mode: ChatMode,
  entityCount: number
): ChatIntent {
  const text = message.trim();
  if (GREETING.test(text) || PLEASANTRY.test(text)) return "conversation";
  if (THANKS.test(text)) return "thanks";
  if (HELP.test(text)) return "help";
  if (mode === "deep") return "deep_research";
  if (COMPARISON.test(text) && entityCount > 1) return "comparison";
  if (
    MACRO.test(text) &&
    (entityCount === 0 || !TIME_SENSITIVE.test(text))
  ) {
    return "macro";
  }
  if (entityCount > 0) return "company_update";
  if (MACRO.test(text)) return "macro";
  return "general_finance";
}

export function conversationalReply(
  intent: ChatIntent,
  message: string
): string | null {
  if (intent === "conversation") {
    if (/good morning/i.test(message)) {
      return "Good morning! What market or company would you like to explore?";
    }
    if (/good (?:afternoon|evening)/i.test(message)) {
      return "Hello! What would you like to know about the markets?";
    }
    if (/how are you|how's it going|how is it going|what'?s up/i.test(message)) {
      return "Doing well and ready to dig into the markets. What’s on your mind?";
    }
    if (/bye|goodbye|see you|have a good day/i.test(message)) {
      return "See you next time. I’ll be here when you have another market question.";
    }
    return "Hey! I’m StockSage. What market or company can I help you with?";
  }
  if (intent === "thanks") {
    return "You’re welcome. Send another market question whenever you’re ready.";
  }
  if (intent === "help") {
    return "I can explain market concepts, summarize company developments, compare investments, and use Deep Research for a more extensive sourced review. Try “What’s new with Apple?” or “Compare Microsoft and Nvidia.”";
  }
  return null;
}

export function isTimeSensitive(intent: ChatIntent, message: string): boolean {
  if (intent === "company_update") return true;
  return TIME_SENSITIVE.test(message);
}

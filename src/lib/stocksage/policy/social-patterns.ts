import { isWithinOneEdit } from "../text-normalization";

// Greetings often carry a throwaway insult in the address slot ("yo fuckass
// whats up"). Without it the turn misses the instant social path and pays for a
// full model round trip.
const NAME_CALL =
  "(?:fuck(?:ass|er|face|head|boy|o)?|dick(?:head)?|ass(?:hole)?|bitch|bastard|prick|shit(?:head)?|idiot|dumbass|moron|loser|nerd|bot|robot)";

export const SOCIAL = new RegExp(
  `^(?:(?:yo+|hey|hi|aight|ok(?:ay)?)[\\s,]+)?(?:${NAME_CALL}[\\s,]+)?(?:` +
    String.raw`(?:hey|hi|hello|hiya|howdy|yo+|sup|wass?up|g'?day|good\s+(?:morning|afternoon|evening)|namaste|n[iǐ]\s*h[aǎ]o|bonjou[re]|hola|ol[aá]|salut|hallo|guten\s+tag|ciao|aloha|shalom|salaam|salam|assalamu\s+alaikum|konnichiwa|hej|merhaba)(?:\s+again)?(?:\s+what'?s\s+gucci)?(?:,\s*i'?m back)?(?:[,\s]+(?:my|boss|bro|mate|dude|there|sage|stocksage))?|i'?m back|how are you(?:\s+(?:doing|going|holding up|today))?|how'?s it going(?:[,\s]+(?:boss|bro|mate|dude))?|what'?s (?:up|good|new|happening)(?:[,\s]+(?:boss|bro|mate|dude))?|nice to meet you|aight(?:\s+gucci)?(?:\s+then)?|gucci|all good(?:\s+then)?|(?:that'?s|thats|dats?|dass)\s+good|no worries|cool(?:\s+cool)?(?:[,\s]+thanks?)?|sounds good|okay|ok|thx|thanks?(?:,\s*that helps|(?:\s+(?:boss|bro|mate|dude|so much|a lot|heaps|man))*)|thank you(?:\s+(?:so much|a lot|boss|bro|mate|dude))*|cheers(?:\s+(?:boss|bro|mate|dude))?|much appreciated|that (?:was|is)(?: actually| really)? helpful|that helps|we good|got it|gotcha)[\s,.!?.-]*$`,
  "i"
);

export const FAREWELL =
  /^(?:(?:thanks?|thank you|thx|cheers|ok(?:ay)?|aight|gucci|all good(?:\s+then)?)[\s,!.]*)?(?:bye|goodbye|farewell|see (?:you|ya)|peace(?:\s+out)?|sayonara|later[sz]?|catch (?:you|ya)(?:\s+later)?|ciao|cya|ttyl|take care|good\s*night|adios|au revoir|auf wiedersehen|hasta luego|arrivederci|alvida|phir milenge|zai\s*jian|i'?m (?:off|out|done(?:\s+for\s+(?:today|the\s+day))?)|gtg|gotta (?:go|run|bounce)|all good then|that'?s (?:all|enough)(?:\s+i\s+gue?s{1,2})?)(?:[\s,]+(?:for now|for today|later|soon|again|then|boss|bro|mate|dude|yaar|bhaijan|friend|man|thanks|thank you|sage))*[\s,.!?.-]*$/i;

export const CASUAL_ACKNOWLEDGEMENT =
  /^(?:(?:thx|thanks?|thank you|cheers)(?:\s+(?:so much|a lot|very much|heaps|boss|bro|mate|dude|man|for (?:that|the help|the info(?:rmation)?)))*(?:,?\s+that helps)?|(?:that'?s|thats|dats?|dass)\s+good|(?:(?:yeah|yep|ok(?:ay)?)[,\s]+)?(?:(?:i\s+guess|ig)\s+)?that\s+works|works\s+for\s+me|that(?:'ll|\s+will)\s+do|fair\s+enough)[\s,.!?.-]*$/i;

const ACKNOWLEDGEMENT_PHRASES = [
  "thanks",
  "thankyou",
  "thanksalot",
  "thankyousomuch",
  "thanksheaps",
  "cheers",
  "muchappreciated",
  "thathelps",
  "thatsgood",
  "thatworks",
  "igthatworks",
  "iguessthatworks",
  "worksforme",
  "fairenough",
] as const;
const FAREWELL_PHRASES = [
  "goodbye",
  "farewell",
  "seeya",
  "seeyou",
  "takecare",
  "thatsall",
  "thatsenough",
  "allgoodthen",
] as const;

function normalizedPhrase(message: string): string {
  return (
    message
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .match(/\p{Letter}+/gu)
      ?.join("") ?? ""
  );
}

function matchesNearbyPhrase(
  message: string,
  phrases: readonly string[]
): boolean {
  const normalized = normalizedPhrase(message);
  return (
    normalized.length >= 5 &&
    phrases.some((phrase) => isWithinOneEdit(normalized, phrase))
  );
}

export function isCasualAcknowledgement(message: string): boolean {
  return (
    CASUAL_ACKNOWLEDGEMENT.test(message) ||
    matchesNearbyPhrase(message, ACKNOWLEDGEMENT_PHRASES)
  );
}

export function isFarewell(message: string): boolean {
  return (
    FAREWELL.test(message) ||
    /^(?:byee+|bai|bbye)[\s,.!?.-]*$/i.test(message) ||
    matchesNearbyPhrase(message, FAREWELL_PHRASES)
  );
}

export const FRUSTRATION =
  /\b(?:fuck|f\*+ck|shit|damn|wtf|ffs|bloody hell)\b.*\b(?:annoying|frustrating|useless|broken|slow|wrong)\b|\bjust (?:tell|give) me (?:the answer|(?:a )?yes or no)\b|\byou'?re not (?:being )?helpful\b/i;

export const HELP =
  /^(?:please\s+)?(?:help|help me|what can you(?: actually)? (?:do|help(?: me)? with)|what can you help with|how can you help|how do i use (?:this|stocksage)|what should i ask)(?:[\s,]+(?:bro|mate|dude|please))?[\s,.!?.-]*$/i;

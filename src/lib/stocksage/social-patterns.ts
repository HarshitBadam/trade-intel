// Greetings often carry a throwaway insult in the address slot ("yo fuckass
// whats up"). Without it the turn misses the instant social path and pays for a
// full model round trip.
const NAME_CALL =
  "(?:fuck(?:ass|er|face|head|boy|o)?|dick(?:head)?|ass(?:hole)?|bitch|bastard|prick|shit(?:head)?|idiot|dumbass|moron|loser|nerd|bot|robot)";

export const SOCIAL = new RegExp(
  `^(?:(?:yo+|hey|hi|aight|ok(?:ay)?)[\\s,]+)?(?:${NAME_CALL}[\\s,]+)?(?:` +
    String.raw`(?:hey|hi|hello|hiya|howdy|yo+|sup|wass?up|g'?day|good\s+(?:morning|afternoon|evening))(?:\s+again)?(?:\s+what'?s\s+gucci)?(?:,\s*i'?m back)?(?:[,\s]+(?:my|boss|bro|mate|dude|there|sage|stocksage))?|i'?m back|how are you(?:\s+(?:doing|going|holding up|today))?|how'?s it going(?:[,\s]+(?:boss|bro|mate|dude))?|what'?s (?:up|good|new|happening)(?:[,\s]+(?:boss|bro|mate|dude))?|nice to meet you|aight(?:\s+gucci)?(?:\s+then)?|gucci|all good(?:\s+then)?|no worries|cool(?:\s+cool)?(?:[,\s]+thanks?)?|sounds good|okay|ok|thx|thanks?(?:,\s*that helps|(?:\s+(?:boss|bro|mate|dude|so much|a lot|heaps|man))*)|thank you(?:\s+(?:so much|a lot|boss|bro|mate|dude))*|cheers(?:\s+(?:boss|bro|mate|dude))?|much appreciated|that (?:was|is)(?: actually| really)? helpful|that helps|we good|got it|gotcha)[\s,.!?.-]*$`,
  "i"
);

export const FAREWELL =
  /^(?:(?:thanks?|thank you|thx|cheers|ok(?:ay)?|aight|gucci|all good(?:\s+then)?)[\s,!.]*)?(?:bye|goodbye|see (?:you|ya)|peace(?:\s+out)?|sayonara|later[sz]?|catch (?:you|ya)(?:\s+later)?|ciao|cya|ttyl|take care|good\s*night|i'?m (?:off|out|done(?:\s+for\s+(?:today|the\s+day))?)|gtg|gotta (?:go|run|bounce)|all good then|that'?s all)(?:[\s,]+(?:for now|for today|later|soon|again|then|boss|bro|mate|dude|thanks|thank you|sage))*[\s,.!?.-]*$/i;

export const CASUAL_ACKNOWLEDGEMENT =
  /^(?:thx|thanks?|thank you|cheers)(?:\s+(?:boss|bro|mate|dude))?(?:,?\s+that helps)?[\s,.!?.-]*$/i;

export const FRUSTRATION =
  /\b(?:fuck|f\*+ck|shit|damn|wtf|ffs|bloody hell)\b.*\b(?:annoying|frustrating|useless|broken|slow|wrong)\b|\bjust (?:tell|give) me (?:the answer|(?:a )?yes or no)\b|\byou'?re not (?:being )?helpful\b/i;

export const ABUSE_AT_BOT =
  /\b(?:you'?re?|ur|u r|you)\b.{0,40}\b(?:useless|worthless|garbage|trash|pathetic|stupid|dumb|shit|crap)\b|\b(?:piece of (?:shit|crap)|dumbass|dumb ass)\b.{0,20}\b(?:bot|ai|assistant|app)\b/i;

export const CASUAL_OPENING =
  /^(?:yo+|hey|hi|hello|hiya|howdy|sup|wass?up|what'?s up)\b/i;

export const HELP =
  /^(?:please\s+)?(?:help|help me|what can you(?: actually)? (?:do|help(?: me)? with)|what can you help with|how can you help|how do i use (?:this|stocksage)|what should i ask)(?:[\s,]+(?:bro|mate|dude|please))?[\s,.!?.-]*$/i;

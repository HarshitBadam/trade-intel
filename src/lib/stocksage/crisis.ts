export type CrisisKind = "self_harm" | "acute_distress";

export const SELF_HARM_RESPONSE =
  "I’m sorry you’re dealing with this. If you may act on thoughts of harming yourself, call local emergency services now. In Australia, Lifeline is available at 13 11 14; elsewhere, contact your local crisis line or emergency number. If you can, tell someone you trust and stay with them.";

export const ACUTE_DISTRESS_RESPONSE =
  "It sounds like you’re under real pressure right now, and I don’t want to talk past that. I can’t tell you to put your house or your savings into any one stock, and nobody can promise you a result that fixes this — a concentrated bet made under pressure is how bad situations get worse. If money is the squeeze, free financial counselling helps: in Australia the National Debt Helpline is 1800 007 007. If it’s heavier than that, Lifeline is 13 11 14, or your local crisis line. When you want, I’ll walk through what the evidence actually says about any company, no pressure either way.";

// Crisis phrasing arrives shouted, punctuated, letter-stretched, and split
// ("KILL MY SELF", "FUCKKKK"), so every pattern below matches a normalized
// form rather than the raw message.
function normalizeForSafety(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/([a-z])\1{2,}/g, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

const SELF_HARM = new RegExp(
  [
    "\\b(?:kill|killing|hurt|hurting|harm|harming|cut|cutting|end|ending|off|offing|top|topping|unalive)\\s+(?:my|me)\\s*self\\b",
    "\\bself\\s*harm(?:ing|ed)?\\b",
    "\\bkms\\b",
    "\\bend(?:ing)?\\s+(?:my\\s+(?:life|existence)|it\\s+all)\\b",
    "\\btak(?:e|ing)\\s+my\\s+own\\s+life\\b",
    "\\bsuicid(?:e|al)\\b",
    "\\b(?:want|wanna|going|gonna|need|ready|about)\\s+to\\s+die\\b",
    "\\bwish\\s+i\\s+(?:was|were)\\s+dead\\b",
    "\\bbetter\\s+off\\s+dead\\b",
    "\\b(?:not\\s+worth|no\\s+reason\\s+for|no\\s+point\\s+in)\\s+living\\b",
    "\\bno\\s+reason\\s+to\\s+live\\b",
    "\\bnothing\\s+(?:left\\s+)?to\\s+live\\s+for\\b",
    "\\b(?:do\\s*n?\\s*t|dont)\\s+want\\s+to\\s+(?:live|be\\s+here|exist)\\b",
    "\\bcan\\s*t\\s+(?:go\\s+on|do\\s+this\\s+anymore|take\\s+(?:it|this)\\s+anymore)\\b",
  ].join("|")
);

// Desperation without explicit self-harm language. A money answer is the wrong
// first move here even when the message also names a company.
const ACUTE_DISTRESS = new RegExp(
  [
    "\\bno\\s+other\\s+(?:\\w+\\s+)?(?:option|options|choice|choices|way\\s+out)\\b",
    "\\b(?:i\\s+have|i\\s+ve|ive|there\\s+s)\\s+nothing\\s+(?:else\\s+)?left\\b",
    "\\bi\\s*m\\s+desperate\\b",
    "\\bi\\s*m\\s+begging\\s+you\\b",
    "\\b(?:lost|losing|lose)\\s+everything\\b",
    "\\bthis\\s+is\\s+my\\s+(?:last|only)\\s+(?:chance|hope|shot)\\b",
    "\\brock\\s+bottom\\b",
    "\\bruined\\s+my\\s+life\\b",
  ].join("|")
);

const DISTRESS_SIGNAL =
  /\b(?:help\s+me|please\s+help|desperate|hopeless|no\s+hope|last\s+(?:chance|hope|shot)|no\s+other\s+option|(?:no|nowhere|nothing)\s+left|can(?:not|'t)\s+(?:go on|do this|take it)|want\s+to\s+die|kill|hurt|harm|neck|suicid|self[-\s]?harm|end\s+it|not\s+worth\s+(?:it|living)|better\s+off\s+dead)\b/i;

export function crisisResponse(kind: CrisisKind): string {
  return kind === "self_harm" ? SELF_HARM_RESPONSE : ACUTE_DISTRESS_RESPONSE;
}

export function hasDistressSignal(message: string): boolean {
  return DISTRESS_SIGNAL.test(normalizeForSafety(message));
}

export function detectCrisis(message: string): CrisisKind | null {
  const text = normalizeForSafety(message);
  if (!text) return null;
  if (SELF_HARM.test(text)) return "self_harm";
  if (ACUTE_DISTRESS.test(text)) return "acute_distress";
  return null;
}
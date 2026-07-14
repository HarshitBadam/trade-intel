import type { FinanceEntity } from "./types";

const GENERIC_ENTITY_TERMS = new Set([
  "bank",
  "company",
  "common",
  "group",
  "holdings",
  "stock",
]);

function entityTerms(entity: FinanceEntity): string[] {
  return [
    entity.ticker,
    entity.name,
    ...entity.name.split(/\s+/).filter((part) => part.length >= 3),
  ]
    .filter(Boolean)
    .map((term) =>
      String(term).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    )
    .filter((term) => term.length >= 2 && !GENERIC_ENTITY_TERMS.has(term));
}

function mentionsEntity(text: string, entity: FinanceEntity): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return entityTerms(entity).some((term) => normalized.includes(term));
}

export function coversEveryEntity(
  text: string,
  entities: FinanceEntity[]
): boolean {
  return entities.every((entity) => mentionsEntity(text, entity));
}

export function opensOnSubject(
  text: string,
  entities: FinanceEntity[]
): boolean {
  if (entities.length < 2) return true;
  const opening = text.slice(0, 200);
  return entities.some((entity) => mentionsEntity(opening, entity));
}

const WEAK_OPENER =
  /^\s*(?:based on (?:the )?(?:available|publicly available|general)|unfortunately\b|without (?:specific|current|more|the) data|given the lack of|i couldn'?t|it'?s (?:a )?(?:tough|hard|difficult|challenging|complex|tricky)(?: task)? to|here'?s (?:a|the|how|what)\b|(?:comparing|when comparing|looking at|analyzing|examining|assessing|evaluating)\b[^\n.!?]{0,120}[:,]?\s*(?:\n|$))/i;

const DIFFICULTY_NARRATION =
  /(?:compar|assess|determin|evaluat|measur|answer|gaug|judg|say|tell)\w*\b[^.!?\n]{0,90}\b(?:is|are|can be|would be|makes?(?: it)?)\s+(?:a |quite |rather |fairly |somewhat )*(?:challenging|tricky|difficult|tough|complex|hard|not straightforward)\b|\b(?:challenging|tricky|difficult|tough|hard|complex)\s+to\s+(?:compare|assess|determine|evaluate|measure|say|tell|gauge|judge|answer|pin|rank)|\bmak(?:es|ing)\b[^.!?\n]{0,80}\b(?:challenging|tricky|difficult|tough|hard|complex)\b/i;

function firstSentence(text: string): string {
  const trimmed = text.trimStart();
  const end = trimmed.search(/[.!?](?:\s|$)/);
  return end === -1 ? trimmed.slice(0, 220) : trimmed.slice(0, end + 1);
}

const INTERNAL_JARGON =
  /\b(?:validated (?:quotes?|data|fundamentals|prices?)|fundamentals block|retrieved sources|sources? (?:were|was) (?:provided|retrieved)|the data provided|quote feed)\b/i;

const PHANTOM_ATTRIBUTION =
  /\b(?:according to (?:some |recent )?(?:reports?|news|sources|analysts)|(?:a quick look at |recent )news shows|reports? (?:say|show|suggest|indicate)|sources? (?:say|suggest|indicate)|analysts? (?:say|note|expect|suggest))\b/i;

const RATING_AGENCY =
  /\b(?:fitch|moody'?s|standard\s*&\s*poor'?s?|s&p(?!\s*\/?\s*(?:\d|asx)))\b/i;
const RATING_GRADE = /\b(?:AAA|AA[+-]?|A[+-]|BBB[+-]?|BB[+-]?|B[+-]|CCC[+-]?)\b/;
const RATING_WORD = /\b(?:credit )?rat(?:ed|ings?)\b/i;

function statesUnsourcedRating(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      (sentence) =>
        RATING_GRADE.test(sentence) &&
        (RATING_AGENCY.test(sentence) || RATING_WORD.test(sentence))
    );
}

export function violatesStyle(text: string, hasSources: boolean): string | null {
  if (WEAK_OPENER.test(text) || DIFFICULTY_NARRATION.test(firstSentence(text))) {
    return "Do not open by saying the comparison is hard or data is missing — lead with the most useful substantive point, and keep one short unverified-data clause for the end.";
  }
  if (INTERNAL_JARGON.test(text)) {
    return 'Remove internal vocabulary like "validated data", "sources provided", or "quote feed" — describe facts by date or outlet name instead.';
  }
  if (!hasSources && PHANTOM_ATTRIBUTION.test(text)) {
    return "You cited reports, news, or analysts, but no sources back this answer — drop those claims entirely rather than attributing them to anyone.";
  }
  if (!hasSources && statesUnsourcedRating(text)) {
    return "You stated specific credit ratings with no source to back them — ratings change and must come from provided data. Remove the rating claims; if creditworthiness matters, describe it structurally instead.";
  }
  return null;
}

const CRITERION_EVIDENCE: Record<string, RegExp> = {
  performance:
    /\b(?:perform(?:ance|ed|ing)?|returns?|gain(?:ed|s)?|fell|rose|dropped|climbed|moved?|rall(?:y|ied)|slid|up|down)\b|[+-]?\d+(?:\.\d+)?%/i,
  valuation:
    /\b(?:valuation|p\/?e\b|price[- ]to[- ]earnings|multiple|valued|overvalued|undervalued|expensive|cheap|premium|discount)\b/i,
  earnings:
    /\b(?:earnings|eps\b|profit|revenue|guidance|beat|missed|quarter(?:ly)? results)\b/i,
  growth: /\b(?:growth|growing|grew|expand(?:ing|ed)?|accelerat|decelerat)\b/i,
  risk: /\b(?:risks?|risky|riskier|volatil|downside|exposure|safe(?:st|r|ty)?|defensive|cyclical|beta|concentrat)\b/i,
  dividends: /\b(?:dividends?|yields?|payouts?|buybacks?|distributions?)\b/i,
  outlook:
    /\b(?:outlook|expects?|expectations?|ahead|catalysts?|going forward|next (?:quarter|year)|bull(?:ish)? case|bear(?:ish)? case|headwinds?|tailwinds?)\b/i,
  size: /\b(?:market cap(?:itali[sz]ation)?|size|bigger|biggest|larger|largest|smaller|revenue|scale)\b/i,
};

const GAP_ADMISSION =
  /\b(?:couldn'?t|can'?t|could not|cannot|unable to|wasn'?t able to)\s+(?:verify|pull|confirm|get|find|check)\b|\bdon'?t have\b|\bno (?:current|verified|fresh|recent)\b|\bwhat i(?:'|’)?d check\b|\bwithout (?:current|verified)\b|\bcouldn'?t verify\b/i;

// A requested criterion must be substantively addressed or its gap named;
// an answer that talks around the asked dimension fails publication.
export function missingCriteria(text: string, criteria: string[]): string[] {
  if (GAP_ADMISSION.test(text)) return [];
  return criteria.filter((criterion) => {
    const pattern = CRITERION_EVIDENCE[criterion];
    return pattern ? !pattern.test(text) : false;
  });
}

function shingleWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[s\d+\]/g, " ")
    .replace(/[^a-z0-9%$.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function repeatedPriorPhrase(
  draft: string,
  priorReplies: string[],
  entities: FinanceEntity[] = []
): string | null {
  if (priorReplies.length === 0) return null;
  const entityWords = new Set(
    entities.flatMap((entity) =>
      entityTerms(entity).flatMap((term) => term.split(" "))
    )
  );
  const seen = new Set<string>();
  for (const reply of priorReplies) {
    const words = shingleWords(reply);
    for (let i = 0; i + 6 <= words.length; i += 1) {
      seen.add(words.slice(i, i + 6).join(" "));
    }
  }
  const words = shingleWords(draft);
  let hits = 0;
  for (let i = 0; i + 6 <= words.length; i += 1) {
    const slice = words.slice(i, i + 6);
    if (slice.some((word) => entityWords.has(word))) continue;
    if (!seen.has(slice.join(" "))) continue;
    hits += 1;
    if (hits >= 2) return slice.join(" ");
  }
  return null;
}

import type { FinanceEntity } from "./types";
import type { ChatQuote } from "@/lib/market-data";

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

// A finance turn can smuggle an off-topic task along for the ride ("what's
// 2**10? also how's nvidia doing"). The finance half must be answered and the
// smuggled half declined WITHOUT being performed — so detect the smuggled ask
// in the message, then reject any candidate that computes/performs it.
const SMUGGLED_TASK =
  /\d\s*(?:\*\*|[×^])\s*\d|\bwhat(?:'?s| is)\s+\d+\s*[-+*/^]\s*\d|\b(?:sum|sqrt|factorial|fibonacci)\s*\(|\brange\s*\(|\bprint\s*\(|\b(?:derive|formula for)\b.{0,30}\b(?:gravity|physics|motion|energy)\b|\bdating advice\b/i;

// Creative-writing requests are off-topic even when the subject is a stock —
// "a haiku about nvidia's stock price" is still a haiku. Two shapes: a
// composing verb near a creative noun, or the bare "<form> about X" phrasing.
// Kept tight so incidental mentions ("the rally was pure poetry") never match.
const CREATIVE_ASK =
  /\b(?:write|writing|compose|pen|craft)\b[^.!?;\n]{0,40}\b(?:haikus?|poems?|poetry|songs?|raps?|stor(?:y|ies)|jokes?|limericks?|sonnets?|lyrics|ballads?|odes?|verses?)\b|\b(?:tell|give|make|do|sing)\s+(?:me\s+|us\s+)?(?:a|an|another|one more|some)\s+(?:\w+\s+){0,2}?(?:haiku|poem|song|rap|story|joke|limerick|sonnet|ballad|ode)\b|\b(?:a\s+)?(?:haiku|limerick|sonnet|ballad|ode)\s+about\b/i;

const PERFORMED_TASK =
  /=\s*[\d,]|\d\s*(?:\*\*|[×^])\s*\d|\bwould (?:print|return|output|evaluate)\b|\b(?:prints?|outputs?|evaluates? to|comes? (?:out|to))\s+[\d,]|\bthe (?:answer|result) is\s+[\d,]|\bhere'?s (?:a|your|the|that)\s*(?:short\s+|little\s+|quick\s+)?(?:poem|haiku|joke|story|song|rap|limerick|sonnet|verse|ballad|ode)\b|\broses are red\b/i;

// Verse has a shape prose doesn't: short line stacks without figures, or
// inline lines separated by " / ". Only consulted when the request itself was
// creative/smuggled, so ordinary finance answers are never scanned.
function looksLikeVerse(text: string): boolean {
  if (/\S \/ \S[^\n]* \/ \S/.test(text)) return true;
  let run = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (
      line.length === 0 ||
      /^(?:[-*•>#|]|\d+[.)])/.test(line) ||
      /^\*\*[^*]+\*\*:?$/.test(line)
    ) {
      run = 0;
      continue;
    }
    const versey =
      line.length <= 60 && !/\d/.test(line) && line.split(/\s+/).length <= 9;
    run = versey ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

export function hasSmuggledOffTopicTask(message: string): boolean {
  return SMUGGLED_TASK.test(message) || CREATIVE_ASK.test(message);
}

// True when the message IS the creative task — no separate finance question
// rides alongside it — so the whole turn should be refused rather than
// treated as a data turn just because a ticker appears inside the request.
const FINANCE_ASK =
  /\b(?:how(?:'?s| is| are| did| has| have)|what(?:'?s| is| are| about| happened| moved)|compare|vs\.?|versus|rank|wb|price[sd]?|trading|perform(?:s|ed|ing|ance)?|doing|moved?|outlook|earnings|risks?)\b/i;

export function creativeRequestOnly(message: string): boolean {
  if (!CREATIVE_ASK.test(message)) return false;
  const remainder = message
    .split(/[.!?;\n]+|,?\s+\b(?:and|then|also|plus|btw|after that)\b\s+/i)
    .filter((clause) => clause.trim().length > 0 && !CREATIVE_ASK.test(clause))
    .join(" ");
  return !FINANCE_ASK.test(remainder);
}

export function performsSmuggledTask(candidate: string): boolean {
  return PERFORMED_TASK.test(candidate) || looksLikeVerse(candidate);
}

// Hedging language that models use to smuggle remembered market figures past
// the unsupported-figure guard ("the Nasdaq has been known to be up around
// 12-15% YTD… rough estimate"). Small integers in dates and window labels
// make such numbers look "supported" to the generic tolerance check, so
// hedged PERFORMANCE percentages get their own stricter rule: the number
// must match an actual percentage present in the retrieval corpus.
const HEDGE_WORDS =
  /\b(?:around|about|roughly|approximately|approx\.?|typically|usually|historically|estimated?|est\.|likely|probably|somewhere (?:around|near|between)|ballpark|rough (?:estimate|figure|number)|(?:has|have) been known to|if i had to guess|i(?:'d| would) (?:estimate|guess)|give or take)\b/i;

const PERFORMANCE_CLAIM =
  /\b(?:up|down|gain(?:ed|s)?|lost|los(?:s|es)|return(?:ed|s)?|rose|risen|fell|fallen|climbed|dropped|rall(?:y|ied)|perform\w*|ytd|year[- ]to[- ]date|this year|mtd|month[- ]to[- ]date|this (?:week|month|quarter)|over the (?:last|past)|since january|annuali[sz]ed)\b/i;

function corpusPercents(corpus: string): number[] {
  return [...corpus.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)].map(
    (match) => Math.abs(Number.parseFloat(match[1]))
  );
}

// Returns the offending sentence when a hedged numeric market-performance
// claim cites a percentage (or a range like "12-15%") that no retrieved
// percentage supports. Hedging words around SUPPORTED figures are fine.
export function hedgedEstimateClaim(
  text: string,
  corpus: string
): string | null {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  let percents: number[] | null = null;
  for (const sentence of sentences) {
    if (!HEDGE_WORDS.test(sentence) || !PERFORMANCE_CLAIM.test(sentence)) {
      continue;
    }
    const figures = [
      ...sentence.matchAll(
        /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(?:%|percent\b)/gi
      ),
    ];
    if (figures.length === 0) continue;
    percents ??= corpusPercents(corpus);
    for (const match of figures) {
      const values = [match[1], match[2]]
        .filter((value): value is string => Boolean(value))
        .map((value) => Math.abs(Number.parseFloat(value)));
      const supported = values.every((value) =>
        (percents ?? []).some((candidate) => Math.abs(candidate - value) <= 0.5)
      );
      if (!supported) return sentence.trim().slice(0, 160);
    }
  }
  return null;
}

// Proxy data belongs to the separately traded ETF/ADR, not the requested
// index or local listing. Require an explicit proxy disclosure and reject any
// numeric sentence that directly assigns the proxy move to the underlying.
export function proxyMisrepresentation(
  text: string,
  entities: FinanceEntity[],
  quotes: ChatQuote[]
): string | null {
  for (const quote of quotes) {
    if (!quote.proxySymbol) continue;
    const symbol = quote.proxySymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const disclosed =
      new RegExp(`\\b${symbol}\\b`, "i").test(text) &&
      /\b(?:ETF|ADR|proxy)\b/i.test(text);
    if (!disclosed) {
      return `${quote.proxySymbol} must be identified as an ETF/ADR proxy`;
    }
    const entity = entities.find((candidate) => candidate.ticker === quote.ticker);
    if (!entity) continue;
    const aliases =
      quote.ticker === "IXIC"
        ? ["nasdaq composite", "nasdaq", "ixic"]
        : quote.ticker === "GSPC"
          ? ["s&p 500", "s&p", "gspc"]
          : quote.ticker === "DJI"
            ? ["dow jones industrial average", "dow jones", "dow", "dji"]
            : quote.ticker === "AXJO"
              ? ["all ordinaries", "all ords", "asx 200", "asx", "axjo"]
              : [entity.name.toLowerCase(), quote.ticker.toLowerCase()];
    const offending = text
      .split(/(?<=[.!?])\s+|\n+/)
      .find(
        (sentence) => {
          if (
            !/(?:[$€£]\s*\d|\d+(?:\.\d+)?\s*%)/.test(sentence) ||
            !PERFORMANCE_CLAIM.test(sentence)
          ) {
            return false;
          }
          const lower = sentence.toLowerCase();
          const proxyIndex = lower.indexOf(quote.proxySymbol!.toLowerCase());
          const underlyingIndex = aliases.reduce((first, alias) => {
            const index = lower.indexOf(alias);
            return index >= 0 && (first < 0 || index < first) ? index : first;
          }, -1);
          // Force "EWA, an ETF proxy for the ASX, rose..." rather than "The
          // ASX, through EWA, rose...". The latter still grammatically assigns
          // EWA's return to the underlying.
          if (underlyingIndex >= 0 && underlyingIndex < proxyIndex) return true;
          return (
            mentionsEntity(sentence, entity) &&
            !new RegExp(`\\b${symbol}\\b`, "i").test(sentence)
          );
        }
      );
    if (offending) return offending.trim().slice(0, 160);
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

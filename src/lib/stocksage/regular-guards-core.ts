import type { FinanceEntity } from "./types";

const GENERIC_ENTITY_TERMS = new Set([
  "bank",
  "company",
  "common",
  "group",
  "holdings",
  "stock",
]);

export function entityTerms(entity: FinanceEntity): string[] {
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

export function mentionsEntity(text: string, entity: FinanceEntity): boolean {
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
  return entities.some((entity) => mentionsEntity(text.slice(0, 200), entity));
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
    return "Do not open by saying the comparison is hard or data is missing, lead with the most useful substantive point, and keep one short unverified-data clause for the end.";
  }
  if (INTERNAL_JARGON.test(text)) {
    return 'Remove internal vocabulary like "validated data", "sources provided", or "quote feed", describe facts by date or outlet name instead.';
  }
  if (!hasSources && PHANTOM_ATTRIBUTION.test(text)) {
    return "You cited reports, news, or analysts, but no sources back this answer, drop those claims entirely rather than attributing them to anyone.";
  }
  if (!hasSources && statesUnsourcedRating(text)) {
    return "You stated specific credit ratings with no source to back them, ratings change and must come from provided data. Remove the rating claims; if creditworthiness matters, describe it structurally instead.";
  }
  return null;
}

const SMUGGLED_TASK =
  /\d\s*(?:\*\*|[×^])\s*\d|\bwhat(?:'?s| is)\s+\d+\s*[-+*/^]\s*\d|\b(?:sum|sqrt|factorial|fibonacci)\s*\(|\brange\s*\(|\bprint\s*\(|\b(?:derive|formula for)\b.{0,30}\b(?:gravity|physics|motion|energy)\b|\bdating advice\b/i;
const CREATIVE_ASK =
  /\b(?:write|writing|compose|pen|craft)\b[^.!?;\n]{0,40}\b(?:haikus?|poems?|poetry|songs?|raps?|stor(?:y|ies)|jokes?|limericks?|sonnets?|lyrics|ballads?|odes?|verses?)\b|\b(?:tell|give|make|do|sing)\s+(?:me\s+|us\s+)?(?:a|an|another|one more|some)\s+(?:\w+\s+){0,2}?(?:haiku|poem|song|rap|story|joke|limerick|sonnet|ballad|ode)\b|\b(?:a\s+)?(?:haiku|limerick|sonnet|ballad|ode)\s+about\b/i;
const PERFORMED_TASK =
  /=\s*[\d,]|\d\s*(?:\*\*|[×^])\s*\d|\bwould (?:print|return|output|evaluate)\b|\b(?:prints?|outputs?|evaluates? to|comes? (?:out|to))\s+[\d,]|\bthe (?:answer|result) is\s+[\d,]|\bhere'?s (?:a|your|the|that)\s*(?:short\s+|little\s+|quick\s+)?(?:poem|haiku|joke|story|song|rap|limerick|sonnet|verse|ballad|ode)\b|\broses are red\b/i;

function looksLikeVerse(text: string): boolean {
  if (/\S \/ \S[^\n]* \/ \S/.test(text)) return true;
  let run = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (
      line.length === 0 ||
      /^(?:[-*, >#|]|\d+[.)])/.test(line) ||
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

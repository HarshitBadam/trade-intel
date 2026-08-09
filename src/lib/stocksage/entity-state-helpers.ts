import { CANONICAL_GROUPS, WEB_ALIASES, type WebAlias } from "./entity-catalog";
import { resolveText } from "./entity-resolution";
import { isWithinOneEdit } from "./text-normalization";
import type { ChatTurn, FinanceEntity } from "./types";
export const PLURAL_REFERENCE = /\b(?:they|their|them|those|these|both)\b/i;
export const CATEGORY_REFERENCE =
  /\b(?:the\s+consultant(?:s|ing)?(?:\s+group)?|the\s+consulting\s+firms?|the\s+accounting\s+firms?)\b/i;
export const SINGULAR_REFERENCE =
  /\b(?:it|its|that one|this one|the company|the bank|the stock|the shares|what about|how about|wb)\b/i;
export const ORDERED_REFERENCE = /\b(?:former|latter|first one|second one)\b/i;
export const COMPARISON_FOLLOW_UP =
  /\b(?:which (?:one|is|looks)|which of (?:the|those|these)|what about|how about|wb|better|safe(?:st|r)|less risky|more risky|more volatile|volatil|rank|order|all of them|former two|latter two)\b/i;
export const CONTEXTUAL_FOLLOW_UP =
  /^(?:(?:and|so|ok(?:ay)?|\.{2,})\s+)?(?:anything notable|what (?:changed|happened|moved)|what(?:'?s| is) (?:your|the) (?:current\s+)?outlook|which (?:one|is|looks|parts?)|(?:can you )?reconcile|how (?:did|has|is|are|was)|why\b|rank\b|order\b|all of them\b|only the (?:former|latter) two\b)/i;
export const REMOVAL =
  /\b(?:forget|drop|remove|ignore|skip|leave out|without)\s+(?:about\s+)?(.+?)(?=\s*(?:[,, -]{1,2}|,|\.|;|!|\?|$))/i;
export const SWAP_IN_CORRECTION =
  /\b(?:swap|sub(?:stitute)?)\s+in\s+(.+?)\s+(?:for|instead of|in place of)\s+(.+?)(?=[.!?,;]|$)/i;
export const SWAP_CORRECTION =
  /\b(?:swap|switch|replace|sub(?:stitute)?)\s+(?:out\s+)?(.+?)\s+(?:out\s+)?(?:for|with|to)\s+(.+?)(?=[.!?,;]|$)/i;
export const NARROWING_TO_SUBSET =
  /\b(?:forget\s+(?:the\s+)?(?:others?|rest)|only\s+(?:those|these)\s+(?:two|three|four|couple)|between\s+(?:those|these)\s+(?:two|three|couple)|just\s+(?:those|these)\s+(?:two|three))\b/i;
export const RESET = /^(?:reset|start (?:over|fresh|again)|clear (?:the )?(?:context|conversation|slate)|new topic)[\s,.!?]*$/i;
export const AUSTRALIAN_BANK_TICKERS = new Set(["CBA", "NAB", "ANZ", "WBC"]);
export const CONSULTING_NAMES = new Set(["Deloitte", "PwC", "EY", "KPMG"]);
export const INDEX_TICKERS = new Set(["IXIC", "GSPC", "DJI", "AXJO"]);
export const STATE_COMMANDS = [
  "forget",
  "drop",
  "remove",
  "ignore",
  "skip",
  "swap",
  "switch",
  "replace",
  "substitute",
] as const;
export function normalizeStateCommand(message: string): string {
  return message.replace(
    /(^|[.!?;]\s*)([a-z]{3,10})(?=\s)/gi,
    (match, prefix: string, token: string) => {
      const lower = token.toLowerCase();
      if (STATE_COMMANDS.includes(lower as (typeof STATE_COMMANDS)[number])) {
        return match;
      }
      const command = STATE_COMMANDS.find((candidate) =>
        isWithinOneEdit(lower, candidate)
      );
      return command ? `${prefix}${command}` : match;
    }
  );
}
export function normalizeOrderedReference(
  message: string,
  hasExplicitPair: boolean
): string {
  if (!hasExplicitPair) return message;
  const hasReferenceContext =
    /\b(?:what about|how about|wb|vs\.?|versus|against|compare|look|doing|perform)\b/i.test(
      message
    );
  if (!hasReferenceContext) return message;
  return message.replace(/\bthe\s+([a-z]{4,8})\b/gi, (match, token: string) => {
    const lower = token.toLowerCase();
    const candidates = ["former", "latter"].filter(
      (candidate) => lower !== candidate && isWithinOneEdit(lower, candidate)
    );
    return candidates.length === 1 ? `the ${candidates[0]}` : match;
  });
}
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function subsetKeepCount(message: string): number {
  const match = message.match(/\b(two|three|four|couple)\b/i);
  const word = match?.[1].toLowerCase();
  if (word === "three") return 3;
  if (word === "four") return 4;
  return 2;
}
export function lastAssistantMentionCounts(
  base: FinanceEntity[],
  history: ChatTurn[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn.role !== "ai") continue;
    for (const entity of base) {
      const terms = [
        entity.ticker,
        entity.name,
        entity.name.split(/[\s,.]+/)[0],
      ].filter(
        (term): term is string => typeof term === "string" && term.length >= 2
      );
      let count = 0;
      for (const term of new Set(terms)) {
        const matches = turn.text.match(
          new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi")
        );
        count += matches?.length ?? 0;
      }
      counts.set(entity.id, count);
    }
    return counts;
  }
  return counts;
}
export function isIndexEntity(entity: FinanceEntity): boolean {
  return (
    (Boolean(entity.ticker) && INDEX_TICKERS.has(entity.ticker as string)) ||
    /\b(?:composite|index|500)\b/i.test(entity.name)
  );
}
export function removalTargets(
  phrase: string,
  base: FinanceEntity[]
): FinanceEntity[] {
  const resolved = resolveText(phrase);
  if (resolved.length > 0) return resolved;
  if (/\b(?:index(?:es)?|indices)\b/i.test(phrase)) {
    return base.filter(isIndexEntity);
  }
  if (/\bbanks?\b/i.test(phrase)) {
    return base.filter(
      (entity) => entity.ticker && AUSTRALIAN_BANK_TICKERS.has(entity.ticker)
    );
  }
  if (/\bconsult|accountants?|firms\b/i.test(phrase)) {
    return base.filter((entity) => CONSULTING_NAMES.has(entity.name));
  }
  if (/\b(?:those|these|them|others?|rest)\b/i.test(phrase)) {
    return base;
  }
  return [];
}

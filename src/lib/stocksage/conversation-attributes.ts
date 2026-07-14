import type { FinanceEntity } from "./types";

export function detectCriteria(message: string): string[] {
  const checks: [RegExp, string][] = [
    [/\b(?:p\/?e|valuation|multiple|price to earnings)\b/i, "valuation"],
    [/\b(?:returns?|performance|price changes?|trading|momentum)\b/i, "performance"],
    [/\b(?:dividend|yield|income)\b/i, "dividends"],
    [/\b(?:growth|revenue|profit|earnings)\b/i, "growth"],
    [/\b(?:risks?|volatility|downside|regulatory|regulation|balance sheet|debt)\b/i, "risk"],
    [/\b(?:outlook|prospects|forecast)\b/i, "outlook"],
    [/\b(?:bigger|biggest|largest|market cap|capitali[sz]ation|size)\b/i, "size"],
  ];
  return checks
    .filter(([pattern]) => pattern.test(message))
    .map(([, criterion]) => criterion);
}

export function detectHorizon(message: string): string | undefined {
  if (/\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\s+(?:ago|back)\b/i.test(message)) {
    return "last few days";
  }
  if (/\b(?:the other day|recently|lately)\b/i.test(message)) {
    return "last few days";
  }
  const match = message.match(
    /\b(?:today|yesterday|this (?:week|month|quarter|year)|last (?:few days|week|month|quarter|year)|(?:past|last|next|over)\s+\d+\s+(?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between\s+\d{4}-\d{2}-\d{2}\s+and\s+\d{4}-\d{2}-\d{2}|(?:on|since|before|after)\s+\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|[135]\s*[- ]?year)\b/i
  );
  return match?.[0].toLowerCase();
}

export function detectJurisdiction(
  message: string,
  entities: FinanceEntity[]
): string | undefined {
  if (/\b(?:australia|australian|aussie|asx)\b/i.test(message)) {
    return "Australia";
  }
  if (/\b(?:united states|u\.?s\.?|nasdaq|nyse)\b/i.test(message)) {
    return "United States";
  }
  const values = new Set(
    entities.map((entity) => entity.jurisdiction).filter(Boolean)
  );
  return values.size === 1 ? ([...values][0] as string) : undefined;
}

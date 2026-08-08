import type { FinanceEntity } from "./types";

export function detectCriteria(message: string): string[] {
  const checks: [RegExp, string][] = [
    [/\b(?:p\/?e|valuation|multiple|price to earnings)\b/i, "valuation"],
    [
      /\b(?:returns?|performance|price changes?|trading|momentum|moved?|doing|doin|done)\b/i,
      "performance",
    ],
    [/\b(?:dividend|yield|income)\b/i, "dividends"],
    [
      /\b(?:earnings|eps\b|net income|net loss|profit margin|operating margin|quarterly results|financial results)\b/i,
      "earnings",
    ],
    [
      /\b(?:growth|growing|grew|revenue|expand(?:ing|ed)?|profit(?:s|ability)?)\b/i,
      "growth",
    ],
    [
      /\b(?:risks?|risky|riskier|volatility|downside|regulatory|regulation|balance sheet|debt|safe(?:st|r|ty)?|exposure|concentrat)\b/i,
      "risk",
    ],
    [
      /\b(?:outlook|prospects|forecast|catalysts?|drivers?|tailwinds?|headwinds?|what (?:(?:should (?:i|we|investors?) )?watch|matters|to watch)|developments?|recover|bounce back|turn around|do (?:well|good) again)\b/i,
      "outlook",
    ],
    [/\b(?:bigger|biggest|largest|market cap|capitali[sz]ation|size)\b/i, "size"],
  ];
  return checks
    .filter(([pattern]) => pattern.test(message))
    .map(([, criterion]) => criterion);
}

export function detectHorizons(message: string): string[] {
  const candidates: { index: number; value: string }[] = [];
  const add = (pattern: RegExp, value: string): void => {
    const match = pattern.exec(message);
    if (match?.index !== undefined) candidates.push({ index: match.index, value });
  };

  add(/\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\s+(?:ago|back)\b/i, "last few days");
  add(/\b(?:the other day|recently|lately)\b/i, "last few days");
  add(/\btoday\b/i, "today");
  add(/\byesterday\b/i, "yesterday");
  add(/\bthis week\b/i, "this week");
  add(/\b(?:month[- ]to[- ]date|mtd|this month|since (?:the )?start of (?:the )?month|month so far)\b/i, "month to date");
  add(/\b(?:trailing month|last month|over the (?:last|past) month|past month)\b/i, "trailing month");
  add(/\b(?:year[- ]to[- ]date|ytd|this year)\b/i, "this year");
  add(/\bthis quarter\b/i, "this quarter");
  add(/\blast (?:few days|week|quarter|year)\b/i, (message.match(/\blast (?:few days|week|quarter|year)\b/i)?.[0] ?? "").toLowerCase());
  add(/\bover the last (?:day|week|quarter|year)\b/i, (message.match(/\bover the last (?:day|week|quarter|year)\b/i)?.[0] ?? "").toLowerCase());

  const dynamic =
    /\b(?:(?:past|last|next|over)\s+\d+\s+(?:days?|weeks?|months?|years?)|between\s+\d{4}-\d{2}-\d{2}\s+and\s+\d{4}-\d{2}-\d{2}|(?:on|since|before|after)\s+\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|[135]\s*[- ]?year)\b/gi;
  for (const match of message.matchAll(dynamic)) {
    candidates.push({ index: match.index, value: match[0].toLowerCase() });
  }

  return candidates
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.value)
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

export function detectHorizon(message: string): string | undefined {
  const horizons = detectHorizons(message);
  return horizons.length > 0 ? horizons.join(" vs ") : undefined;
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

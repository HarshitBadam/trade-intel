import type { FinanceEntity } from "../types";

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

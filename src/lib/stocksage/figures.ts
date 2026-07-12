const MAGNITUDES: Record<string, number> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  m: 1e6,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  trillion: 1e12,
  tn: 1e12,
};

const FIGURE_PATTERN =
  /([A-Za-z]{0,2}[$€£]\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(%|percent(?:age points?)?\b|trillion\b|billion\b|million\b|thousand\b|bps\b|tn\b|bn\b|[kmbx]\b))?/gi;

type Figure = {
  raw: string;
  values: number[];
  tolerance: number;
};

function parseFigures(text: string, includeBareNumbers: boolean): Figure[] {
  const figures: Figure[] = [];
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const currency = Boolean(match[1]?.trim());
    const suffix = match[3]?.toLowerCase() ?? "";
    const numberText = match[2] ?? "";
    const hasDecimal = numberText.includes(".");
    const hasThousands = numberText.includes(",");
    const isFigure =
      currency || Boolean(suffix) || hasDecimal || hasThousands;
    if (!isFigure && !includeBareNumbers) continue;
    const value = Math.abs(Number.parseFloat(numberText.replace(/,/g, "")));
    if (!Number.isFinite(value)) continue;
    const scale = MAGNITUDES[suffix] ?? 1;
    const decimals = hasDecimal ? numberText.split(".")[1].length : 0;
    figures.push({
      raw: match[0].trim(),
      values: scale === 1 ? [value] : [value, value * scale],
      tolerance: 0.5 * 10 ** -decimals,
    });
  }
  return figures;
}

export function unsupportedFigures(text: string, corpus: string): string[] {
  const evidence = new Set<number>();
  for (const figure of parseFigures(corpus, true)) {
    for (const value of figure.values) evidence.add(value);
  }
  const corpusValues = [...evidence];
  const unsupported: string[] = [];
  for (const figure of parseFigures(text, false)) {
    const supported = figure.values.some((value, index) => {
      const scale = index === 0 ? 1 : value / figure.values[0] || 1;
      const tolerance = figure.tolerance * scale;
      return corpusValues.some(
        (candidate) => Math.abs(candidate - value) <= tolerance
      );
    });
    if (!supported) unsupported.push(figure.raw);
  }
  return [...new Set(unsupported)];
}

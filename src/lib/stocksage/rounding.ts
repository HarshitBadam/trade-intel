// Normalize high-precision published metrics without rewriting URLs or links.

const PROTECTED_SPANS =
  /!?\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)|https?:\/\/\S+/g;

const LONG_DECIMAL =
  /(^|[^.\d])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{3,})(?!\.?\d)/g;

const RATIO_CONTEXT =
  /\b(?:beta|p\/?e|multiple|ratio|times)\b|[x×]/i;

function decimalsFor(
  text: string,
  matchStart: number,
  matchEnd: number
): number {
  const before = text.slice(Math.max(0, matchStart - 24), matchStart);
  const after = text.slice(matchEnd, matchEnd + 8);
  if (/[$€£]\s*$/.test(before)) return 2;
  if (/^\s?%/.test(after) || /^\s?percent/i.test(after)) return 2;
  if (RATIO_CONTEXT.test(after) || RATIO_CONTEXT.test(before)) return 1;
  return 2;
}

function formatRounded(raw: string, decimals: number): string {
  const value = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) return raw;
  const rounded = value.toFixed(decimals);
  if (!raw.includes(",")) return rounded;
  return Number.parseFloat(rounded).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function roundSegment(segment: string): string {
  return segment.replace(
    LONG_DECIMAL,
    (match, prefix: string, num: string, offset: number) => {
      const start = offset + prefix.length;
      const end = offset + match.length;
      return `${prefix}${formatRounded(num, decimalsFor(segment, start, end))}`;
    }
  );
}

export function roundFiguresForDisplay(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(PROTECTED_SPANS)) {
    const index = match.index ?? 0;
    result += roundSegment(text.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  result += roundSegment(text.slice(cursor));
  return result;
}

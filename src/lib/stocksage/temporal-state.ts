import {
  temporalIntervalKey,
  type TemporalInterval,
} from "./temporal-types";

const CONTRAST_FOLLOW_UP =
  /\b(?:contrast|compared?\s+(?:that|it|them|those)?\s*(?:with|to)|different from|versus|vs\.?)\b/i;

// Contrast follow-ups add one period; ordinary explicit periods replace state.
export function mergeContrastIntervals(args: {
  message: string;
  previous: readonly TemporalInterval[];
  parsed: readonly TemporalInterval[];
}): TemporalInterval[] {
  if (args.parsed.length === 0) {
    return args.previous.map((value) => ({
      ...value,
      source: "inherited" as const,
    }));
  }
  if (
    args.previous.length === 0 ||
    args.parsed.length !== 1 ||
    !CONTRAST_FOLLOW_UP.test(args.message)
  ) {
    return [...args.parsed];
  }
  const combined = [
    ...args.previous.map((value) => ({
      ...value,
      source: "inherited" as const,
    })),
    ...args.parsed,
  ];
  const seen = new Set<string>();
  return combined
    .filter((value) => {
      const key = temporalIntervalKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

export function intervalsToHorizon(
  intervals: TemporalInterval[]
): string | undefined {
  return intervals.length > 0
    ? intervals.map((value) => value.label).join(" vs ")
    : undefined;
}

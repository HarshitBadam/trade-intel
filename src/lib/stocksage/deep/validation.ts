import type { DeepResearchSnapshot } from "./snapshot";

const GENERIC_NAME_PARTS = new Set([
  "class",
  "common",
  "company",
  "corp",
  "corporation",
  "global",
  "group",
  "holdings",
  "inc",
  "limited",
  "ordinary",
  "stock",
]);

function entityTerms(name: string, ticker?: string): string[] {
  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = normalizedName
    .split(" ")
    .filter(
      (word) =>
        (word.length >= 3 || normalizedName.length === 2) &&
        !GENERIC_NAME_PARTS.has(word)
    );
  return [...new Set([ticker?.toLowerCase(), ...words].filter(Boolean))] as string[];
}

export function validateDeepResearchResult(args: {
  snapshot: DeepResearchSnapshot;
  text: string;
  citationUrls: string[];
}): string | null {
  const normalized = args.text.toLowerCase();
  const missing = args.snapshot.entities.filter(
    (entity) =>
      !entityTerms(entity.name, entity.ticker).some((term) =>
        normalized.includes(term)
      )
  );
  if (missing.length > 0) {
    return `Research deeper did not cover ${missing.map((entity) => entity.name).join(", ")}. The regular answer remains available; please retry.`;
  }
  if (args.citationUrls.length === 0) {
    return "Research deeper returned no verifiable citations. The regular answer remains available; please retry.";
  }
  return null;
}

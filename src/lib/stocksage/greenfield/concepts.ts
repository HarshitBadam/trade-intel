import type { ResearchEvidence } from "./research";

export type FinanceConcept = {
  id: string;
  names: readonly string[];
  title: string;
  definition: string;
  caveat?: string;
  sourceUrl: string;
  reviewedAt: string;
};

export const FINANCE_CONCEPTS: readonly FinanceConcept[] = [
  {
    id: "pe_ratio",
    names: ["p/e", "p/e ratio", "price earnings", "price to earnings"],
    title: "Price-to-earnings ratio",
    definition:
      "The price-to-earnings ratio divides a share's market price by earnings per share for the same earnings basis. It shows how much investors are paying for each unit of earnings.",
    caveat:
      "A lower ratio is not automatically better: growth expectations, cyclicality, accounting quality, leverage, and whether earnings are temporarily depressed all affect comparability.",
    sourceUrl:
      "https://www.investor.gov/introduction-investing/investing-basics/glossary/price-earnings-pe-ratio",
    reviewedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "market_cap",
    names: ["market cap", "market capitalization"],
    title: "Market capitalization",
    definition:
      "Market capitalization is the market value of a company's outstanding common shares: share price multiplied by shares outstanding.",
    caveat:
      "It is an equity value, not enterprise value, and does not by itself measure the value of the whole operating business.",
    sourceUrl:
      "https://www.investor.gov/introduction-investing/investing-basics/glossary/market-capitalization",
    reviewedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "dividend_yield",
    names: ["dividend yield"],
    title: "Dividend yield",
    definition:
      "Dividend yield is annual dividends per share divided by the share price, normally expressed as a percentage.",
    caveat:
      "A high trailing yield can reflect a falling price or a dividend that the company may not sustain.",
    sourceUrl:
      "https://www.investor.gov/introduction-investing/investing-basics/glossary/dividend-yield",
    reviewedAt: "2026-08-01T00:00:00.000Z",
  },
] as const;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

export function findFinanceConcept(labels: readonly string[]): FinanceConcept | null {
  const normalized = labels.map(normalize).filter(Boolean);
  return (
    FINANCE_CONCEPTS.find((concept) =>
      concept.names.some((name) => {
        const key = normalize(name);
        return normalized.some((label) => label.includes(key) || key.includes(label));
      })
    ) ?? null
  );
}

export function conceptEvidence(
  concept: FinanceConcept,
  retrievedAt: string
): ResearchEvidence {
  return {
    id: `concept:${concept.id}`,
    sourceId: "investor.gov",
    sourceUrl: concept.sourceUrl,
    title: concept.title,
    excerpt: [concept.definition, concept.caveat].filter(Boolean).join(" "),
    retrievedAt,
    availableAt: concept.reviewedAt,
    quality: 1,
    supports: [
      `definition:${concept.id}`,
      ...(concept.caveat ? [`caveat:${concept.id}`] : []),
    ],
    facts: {
      definition: { value: concept.definition },
      ...(concept.caveat ? { caveat: { value: concept.caveat } } : {}),
    },
  };
}

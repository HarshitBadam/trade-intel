import type { EvidenceInput } from "./citations";
import type {
  EvidencePlan,
  EvidenceSource,
  FinanceEntity,
} from "./types";
import { createEvidenceSources } from "./citations";

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const GENERIC_ENTITY_TERMS = new Set([
  "class",
  "common",
  "company",
  "corp",
  "corporation",
  "global",
  "group",
  "holdings",
  "limited",
  "ordinary",
  "stock",
]);

function entityTerms(entity: FinanceEntity): string[] {
  const name = normalized(entity.name);
  const terms = [name, normalized(entity.ticker ?? "")].filter(
    (term) => term.length >= 3
  );
  if (name.includes(" ")) {
    terms.push(
      ...name
        .split(" ")
        .filter(
          (term) => term.length >= 4 && !GENERIC_ENTITY_TERMS.has(term)
        )
    );
  }
  return [...new Set(terms)];
}

function mentionsEntity(input: EvidenceInput, entity: FinanceEntity): boolean {
  const haystack = normalized(`${input.title} ${input.excerpt} ${input.url}`);
  return entityTerms(entity).some((term) => haystack.includes(term));
}

const CRITERION_TERMS: Record<string, RegExp> = {
  valuation: /\b(?:valuation|p\/?e|multiple|price to earnings)\b/i,
  performance: /\b(?:performance|return|price|shares?|stock|trading)\b/i,
  outlook: /\b(?:outlook|forecast|guidance|prospects?)\b/i,
  risk: /\b(?:risk|regulat|volatility|downside|debt|legal)\b/i,
  growth: /\b(?:growth|earnings|revenue|profit)\b/i,
  earnings:
    /\b(?:earnings|revenue|net income|net loss|profitability|operating margin|eps|financial results|quarterly results)\b/i,
  dividends: /\b(?:dividend|yield|income)\b/i,
  "current developments": /\b(?:update|news|today|recent|report|announce|earnings|price|shares?|stock|rose|fell|guidance|regulat|lawsuit)\b/i,
};

function matchedCriteria(
  input: EvidenceInput,
  criteria: string[]
): string[] {
  const text = `${input.title} ${input.excerpt}`;
  return criteria.filter((criterion) => {
    const pattern = CRITERION_TERMS[criterion];
    return pattern ? pattern.test(text) : normalized(text).includes(normalized(criterion));
  });
}

function freshEnough(
  input: EvidenceInput,
  plan: EvidencePlan,
  freshnessDays: number | undefined
): boolean {
  if (!freshnessDays) return true;
  if (!input.publishedAt) return false;
  const published = Date.parse(input.publishedAt);
  const asOf = Date.parse(plan.asOf);
  if (!Number.isFinite(published) || !Number.isFinite(asOf)) return false;
  return published >= asOf - freshnessDays * 24 * 60 * 60 * 1000;
}

function contentDateCompatible(
  input: EvidenceInput,
  plan: EvidencePlan,
  freshnessDays: number | undefined
): boolean {
  if (!freshnessDays || freshnessDays > 60) return true;
  const asOfYear = new Date(plan.asOf).getUTCFullYear();
  const years = [
    ...`${input.title} ${input.excerpt}`.matchAll(/\b(20\d{2})\b/g),
  ].map((match) => Number(match[1]));
  return years.length === 0 || Math.max(...years) >= asOfYear - 1;
}

export function filterEvidence(args: {
  inputs: EvidenceInput[];
  plan: EvidencePlan;
  entities: FinanceEntity[];
}): EvidenceSource[] {
  const byId = new Map(args.entities.map((entity) => [entity.id, entity]));
  const freshnessByQuery = new Map(
    args.plan.queries.map((query) => [query.id, query.freshnessDays])
  );
  const accepted = args.inputs.flatMap((input) => {
    if (input.score !== undefined && input.score < 0.15) return [];
    const freshnessDays = input.queryId
      ? freshnessByQuery.get(input.queryId)
      : undefined;
    if (!freshEnough(input, args.plan, freshnessDays)) return [];
    if (!contentDateCompatible(input, args.plan, freshnessDays)) return [];
    const assigned = (input.entityIds ?? [])
      .map((id) => byId.get(id))
      .filter((entity): entity is FinanceEntity => Boolean(entity));
    if (
      assigned.length > 0 &&
      !assigned.some((entity) => mentionsEntity(input, entity))
    ) {
      return [];
    }
    if (assigned.length === 0 && args.plan.requiredEntityIds.length > 0) {
      return [];
    }
    const criteria = matchedCriteria(input, input.criteria ?? []);
    if ((input.criteria?.length ?? 0) > 0 && criteria.length === 0) return [];
    return [{ ...input, criteria }];
  });
  return createEvidenceSources(accepted, 8);
}

export function evidenceCoverage(args: {
  plan: EvidencePlan;
  sources: EvidenceSource[];
  quotedEntityIds: string[];
}): Record<string, "covered" | "missing"> {
  const quoted = new Set(args.quotedEntityIds);
  const result: Record<string, "covered" | "missing"> = {};
  for (const entityId of args.plan.requiredEntityIds) {
    const sourceCriteria = new Set(
      args.sources
        .filter((source) => source.entityIds.includes(entityId))
        .flatMap((source) => source.criteria)
    );
    if (quoted.has(entityId)) sourceCriteria.add("performance");
    result[entityId] = args.plan.criteria.every((criterion) =>
      sourceCriteria.has(criterion)
    )
      ? "covered"
      : "missing";
  }
  return result;
}

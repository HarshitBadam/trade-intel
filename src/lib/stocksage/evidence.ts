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

const EXCLUDED_EVIDENCE_HOSTS = [
  "facebook.com",
  "instagram.com",
  "reddit.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
];
const WEAK_METRIC_HOSTS = [
  "247wallst.com",
  "50pros.com",
  "alphaspread.com",
  "hireinsouth.com",
  "macroaxis.com",
  "sharewise.com",
];
const HIGH_AUTHORITY_HOSTS = [
  "sec.gov",
  "fortune.com",
  "fortunemedia.mediaroom.com",
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "investor.",
  "ir.",
];

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, candidates: string[]): boolean {
  return candidates.some(
    (candidate) =>
      host === candidate ||
      host.endsWith(`.${candidate}`) ||
      host.includes(candidate)
  );
}

function evidenceAuthority(input: EvidenceInput): number {
  const host = hostname(input.url);
  if (hostMatches(host, HIGH_AUTHORITY_HOSTS)) return 4;
  if (
    hostMatches(host, [
      "cnbc.com",
      "finance.yahoo.com",
      "morningstar.com",
      "nasdaq.com",
      "nyse.com",
      "wsj.com",
    ])
  ) {
    return 3;
  }
  if (input.kind === "astra") return 2;
  return 1;
}

function acceptableAuthority(input: EvidenceInput): boolean {
  const host = hostname(input.url);
  if (!host || hostMatches(host, EXCLUDED_EVIDENCE_HOSTS)) return false;
  const criteria = input.criteria ?? [];
  if (criteria.includes("revenue ranking")) {
    return hostMatches(host, ["fortune.com", "fortunemedia.mediaroom.com"]);
  }
  if (
    criteria.some((criterion) =>
      ["earnings", "valuation", "growth", "risk", "performance"].includes(
        criterion
      )
    ) &&
    hostMatches(host, WEAK_METRIC_HOSTS)
  ) {
    return false;
  }
  return true;
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
    (term) => term.length >= 3 || (name.length === 2 && term === name)
  );
  if (name === "fortune 100") terms.push("fortune 500");
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
  let host = "";
  try {
    host = new URL(input.url).hostname;
  } catch {
    host = "";
  }
  const haystack = normalized(
    `${input.title} ${host} ${input.excerpt.slice(0, 280)}`
  );
  return entityTerms(entity).some((term) =>
    term.length <= 2
      ? new RegExp(`(?:^| )${term}(?: |$)`).test(haystack)
      : haystack.includes(term)
  );
}

function balanceByEntity(
  inputs: EvidenceInput[],
  requiredEntityIds: string[]
): EvidenceInput[] {
  if (requiredEntityIds.length < 2) return inputs;
  const selected: EvidenceInput[] = [];
  const seen = new Set<string>();
  const queues = requiredEntityIds.map((entityId) =>
    inputs.filter((input) => input.entityIds?.includes(entityId))
  );
  for (let index = 0; queues.some((queue) => index < queue.length); index += 1) {
    for (const queue of queues) {
      const input = queue[index];
      if (!input) continue;
      const key = input.url;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(input);
    }
  }
  for (const input of inputs) {
    if (seen.has(input.url)) continue;
    seen.add(input.url);
    selected.push(input);
  }
  return selected;
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
  size: /\b(?:market cap|capitali[sz]ation|assets|revenue|largest|biggest|size|valued at)\b/i,
  "revenue ranking": /\b(?:fortune|rank(?:ed|ing)?|revenue|sales)\b/i,
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
  if (!input.publishedAt) {
    const asOfYear = new Date(plan.asOf).getUTCFullYear();
    return (
      input.criteria?.includes("revenue ranking") === true &&
      new RegExp(`\\b${asOfYear}\\b`).test(`${input.title} ${input.excerpt}`)
    );
  }
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
    if (!acceptableAuthority(input)) return [];
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
  // Relevance gate: when the user asked for specific criteria, sources that
  // address none of them are tangential — keep one only where dropping it
  // would leave an entity with no evidence at all. A named gap beats a
  // confident citation of an unrelated article.
  const planCriteria = args.plan.criteria.filter(
    (criterion) => criterion in CRITERION_TERMS
  );
  const relevant =
    planCriteria.length === 0
      ? accepted
      : (() => {
          const onCriterion = accepted.filter(
            (input) => matchedCriteria(input, planCriteria).length > 0
          );
          const coveredEntities = new Set(
            onCriterion.flatMap((input) => input.entityIds ?? [])
          );
          const coverageFillers = accepted.filter(
            (input) =>
              matchedCriteria(input, planCriteria).length === 0 &&
              (input.entityIds ?? []).some(
                (entityId) => !coveredEntities.has(entityId)
              )
          );
          return [...onCriterion, ...coverageFillers];
        })();
  const ranked = [...relevant].sort(
    (left, right) =>
      matchedCriteria(right, planCriteria).length -
        matchedCriteria(left, planCriteria).length ||
      evidenceAuthority(right) - evidenceAuthority(left) ||
      (right.score ?? 0) - (left.score ?? 0)
  );
  const balanced = balanceByEntity(ranked, args.plan.requiredEntityIds);
  const limit = Math.min(
    12,
    Math.max(8, args.plan.requiredEntityIds.length)
  );
  return createEvidenceSources(balanced, limit);
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

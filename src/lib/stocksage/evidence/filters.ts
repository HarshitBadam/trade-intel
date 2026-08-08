import type { EvidenceInput } from "../citations";
import type {
  EvidenceDiagnostics,
  EvidencePlan,
  EvidenceRejectionReason,
  EvidenceSource,
  FinanceEntity,
} from "../types";
import { createEvidenceSources } from "../citations";
import { addDays } from "../temporal";

function normalizeSearchText(value: string): string {
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
  const name = normalizeSearchText(entity.name);
  const terms = [name, normalizeSearchText(entity.ticker ?? "")].filter(
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

function entityProminence(input: EvidenceInput, entity: FinanceEntity): number {
  const host = hostname(input.url);
  const terms = entityTerms(entity);
  const primary = normalizeSearchText(`${input.title} ${host}`);
  if (
    terms.some((term) =>
      term.length <= 2
        ? new RegExp(`(?:^| )${term}(?: |$)`).test(primary)
        : primary.includes(term)
    )
  ) {
    return 4;
  }
  const excerpt = normalizeSearchText(input.excerpt.slice(0, 360));
  const mentions = terms.reduce((total, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      total +
      (excerpt.match(new RegExp(`(?:^| )${escaped}(?= |$)`, "g"))?.length ?? 0)
    );
  }, 0);
  if (mentions >= 3) return 3;
  if (
    mentions >= 2 &&
    input.ticker?.trim().toUpperCase() === entity.ticker?.trim().toUpperCase()
  ) {
    return 3;
  }
  return mentions >= 2 ? 2 : 0;
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
  outlook:
    /\b(?:outlooks?|forecasts?|guidance|prospects?|catalysts?|drivers?|tailwinds?|headwinds?|launch(?:es|ed|ing)?|roadmaps?|demand|orders?|shipments?|capacity|product cycles?|next quarter|going forward|expan(?:d|ds|ded|ding|sion)|adopt(?:s|ed|ing|ion))\b/i,
  risk:
    /\b(?:risks?|regulat\w*|volatility|downside|debt|legal|headwinds?|competition|competitive|constraints?|shortages?|export controls?|restrictions?|delays?|uncertain(?:ty)?|pressure|depend(?:s|ed|ence|ency)?|concentrat\w*|cyclical)\b/i,
  growth: /\b(?:growth|grow(?:s|ing|th)?|grew|earnings|revenue|profit|expan(?:d|ds|ded|ding|sion))\b/i,
  earnings:
    /\b(?:earnings|revenue|net income|net loss|profitability|operating margin|eps|financial results|quarterly results)\b/i,
  dividends: /\b(?:dividend|yield|income)\b/i,
  size: /\b(?:market cap|capitali[sz]ation|assets|revenue|largest|biggest|size|valued at)\b/i,
  "revenue ranking": /\b(?:fortune|rank(?:ed|ing)?|revenue|sales)\b/i,
  "current developments": /\b(?:updates?|news|today|recent(?:ly)?|reports?|report(?:ed|ing)?|announc(?:e|es|ed|ing|ement)|earnings|prices?|shares?|stocks?|rose|fell|guidance|regulat\w*|lawsuits?|launch(?:es|ed|ing)?|partnerships?|invest(?:s|ed|ment)|expan(?:d|ds|ded|ding|sion)|adopt(?:s|ed|ing|ion))\b/i,
};

const SECURITY_EVENT =
  /\b(?:UEFI|secure boot|bootloaders?|cybersecurity|vulnerabilit(?:y|ies)|malware|ransomware|data breach)\b/i;

function matchedCriteria(
  input: EvidenceInput,
  criteria: string[]
): string[] {
  const text = `${input.title} ${input.excerpt}`;
  return criteria.filter((criterion) => {
    const pattern = CRITERION_TERMS[criterion];
    return pattern
      ? pattern.test(text)
      : normalizeSearchText(text).includes(normalizeSearchText(criterion));
  });
}

function isFreshEnough(
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

function causalDateCompatible(
  input: EvidenceInput,
  plan: EvidencePlan
): boolean {
  if (!plan.causal) return true;
  if (!input.publishedAt) return false;
  const published = new Date(input.publishedAt);
  if (!Number.isFinite(published.getTime())) return false;
  const publishedDate = published.toISOString().slice(0, 10);
  const intervals = plan.intervals ?? [];
  if (intervals.length === 0) return true;
  return intervals.some(
    (interval) =>
      publishedDate >= addDays(interval.startSession, -1) &&
      publishedDate <= addDays(interval.endSession, 1)
  );
}

export function filterEvidenceWithDiagnostics(args: {
  inputs: EvidenceInput[];
  plan: EvidencePlan;
  entities: FinanceEntity[];
}): {
  sources: EvidenceSource[];
  /** Validated/deduplicated evidence before the display/cache source cap. */
  acceptedSources: EvidenceSource[];
  diagnostics: EvidenceDiagnostics;
} {
  const rejected: EvidenceDiagnostics["rejected"] = {};
  const reject = (reason: EvidenceRejectionReason): [] => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
    return [];
  };
  const byId = new Map(args.entities.map((entity) => [entity.id, entity]));
  const freshnessByQuery = new Map(
    args.plan.queries.map((query) => [query.id, query.freshnessDays])
  );
  const accepted = args.inputs.flatMap((input) => {
    if (input.score !== undefined && input.score < 0.15) {
      return reject("low_provider_score");
    }
    if (!acceptableAuthority(input)) return reject("unsafe_authority");
    const freshnessDays = input.queryId
      ? freshnessByQuery.get(input.queryId)
      : undefined;
    if (!isFreshEnough(input, args.plan, freshnessDays)) return reject("stale");
    if (!contentDateCompatible(input, args.plan, freshnessDays)) {
      return reject("stale_content");
    }
    if (!causalDateCompatible(input, args.plan)) return reject("stale");
    const assigned = (input.entityIds ?? [])
      .map((id) => byId.get(id))
      .filter((entity): entity is FinanceEntity => Boolean(entity));
    if (
      assigned.length > 0 &&
      !assigned.some((entity) => entityProminence(input, entity) >= 2)
    ) {
      return reject("entity_mismatch");
    }
    if (assigned.length === 0 && args.plan.requiredEntityIds.length > 0) {
      return reject("missing_entity");
    }
    const criteria = matchedCriteria(input, input.criteria ?? []);
    if ((input.criteria?.length ?? 0) > 0 && criteria.length === 0) {
      return reject("criterion_mismatch");
    }
    if (
      args.plan.route === "comparison" &&
      (args.plan.explicitCriteria?.length ?? 0) === 0 &&
      SECURITY_EVENT.test(`${input.title} ${input.excerpt}`)
    ) {
      return reject("criterion_mismatch");
    }
    const prominence = Math.max(
      0,
      ...assigned.map((entity) => entityProminence(input, entity))
    );
    const published = input.publishedAt ? Date.parse(input.publishedAt) : 0;
    const ageDays =
      Number.isFinite(published) && published > 0
        ? Math.max(0, (Date.parse(args.plan.asOf) - published) / 86_400_000)
        : 365;
    const freshnessScore = Math.max(0, 3 - ageDays / 30);
    const importance =
      input.importance?.toLowerCase() === "high"
        ? 3
        : input.importance?.toLowerCase() === "medium"
          ? 2
          : 1;
    return [
      {
        ...input,
        criteria,
        relevanceScore:
          prominence * 3 +
          criteria.length * 3 +
          evidenceAuthority(input) +
          freshnessScore +
          importance +
          (input.score ?? 0),
      },
    ];
  });
  const planCriteria = args.plan.criteria.filter(
    (criterion) => criterion in CRITERION_TERMS
  );
  const relevant =
    planCriteria.length === 0
      ? accepted
      : accepted.filter(
          (input) => matchedCriteria(input, planCriteria).length > 0
        );
  const ranked = [...relevant].sort(
    (left, right) =>
      (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) ||
      matchedCriteria(right, planCriteria).length -
        matchedCriteria(left, planCriteria).length ||
      evidenceAuthority(right) - evidenceAuthority(left) ||
      (right.score ?? 0) - (left.score ?? 0)
  );
  const balanced = balanceByEntity(ranked, args.plan.requiredEntityIds);
  const limit = Math.min(4, Math.max(2, args.plan.requiredEntityIds.length));
  const acceptedSources = createEvidenceSources(balanced, balanced.length);
  const sources = acceptedSources.slice(0, limit);
  const invalidOrDuplicate = Math.max(
    0,
    balanced.length - acceptedSources.length
  );
  if (invalidOrDuplicate > 0) rejected.invalid_source = invalidOrDuplicate;
  return {
    sources,
    acceptedSources,
    diagnostics: {
      inputCount: args.inputs.length,
      acceptedCount: acceptedSources.length,
      cacheHitCount: 0,
      rejected,
    },
  };
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

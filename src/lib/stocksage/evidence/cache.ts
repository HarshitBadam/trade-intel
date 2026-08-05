import "server-only";

import { createHash } from "node:crypto";
import { hasUpstash } from "@/lib/config";
import { readAnalysisDoc } from "@/lib/market-data/news-store";
import type { EvidenceInput } from "../citations";
import type {
  EvidencePlan,
  EvidenceSource,
  FinanceEntity,
} from "../types";

const TTL_SECONDS = 15 * 60;
const MAX_MEMORY_ENTRIES = 256;
const memory = new Map<string, { expiresAt: number; sources: EvidenceSource[] }>();
export type EvidenceRevisions = Record<string, string>;
export const MISSING_INTELLIGENCE_REVISION = "generation-0";

async function redis() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

function freshnessBucket(plan: EvidencePlan, entityId: string): string {
  const days = Math.max(
    1,
    ...plan.queries
      .filter(
        (query) =>
          (query.provider === "astra" || query.provider === "tavily") &&
          query.entityIds.includes(entityId)
      )
      .map((query) => query.freshnessDays ?? 60)
  );
  return days <= 14 ? "14d" : days <= 60 ? "60d" : "long";
}

function criteriaKey(criteria: string[]): string {
  return [...new Set(criteria.map((item) => item.toLowerCase()))]
    .sort()
    .join("+") || "general";
}

function revisionKey(revision: string | undefined): string {
  return createHash("sha256")
    .update(revision || MISSING_INTELLIGENCE_REVISION)
    .digest("hex")
    .slice(0, 20);
}

function key(
  entityId: string,
  criteria: string[],
  plan: EvidencePlan,
  revision?: string
): string {
  const entity = entityId.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-");
  return `stocksage:evidence:v2:${entity}:${criteriaKey(criteria)}:${freshnessBucket(plan, entityId)}:${revisionKey(revision)}`;
}

function criteriaFor(plan: EvidencePlan, entityId: string): string[] {
  return [
    ...new Set(
      plan.queries
        .filter(
          (query) =>
            (query.provider === "astra" || query.provider === "tavily") &&
            query.entityIds.includes(entityId)
        )
        .flatMap((query) => query.criteria)
    ),
  ];
}

function sweepMemory(now: number = Date.now()): void {
  for (const [cacheKey, value] of memory) {
    if (value.expiresAt <= now) memory.delete(cacheKey);
  }
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }
}

async function readKey(cacheKey: string): Promise<EvidenceSource[]> {
  if (hasUpstash) {
    try {
      const value = await (await redis()).get<EvidenceSource[]>(cacheKey);
      if (Array.isArray(value)) return value;
    } catch {}
  }
  sweepMemory();
  const value = memory.get(cacheKey);
  if (!value || value.expiresAt <= Date.now()) {
    memory.delete(cacheKey);
    return [];
  }
  return value.sources;
}

async function writeKey(
  cacheKey: string,
  sources: EvidenceSource[]
): Promise<void> {
  sweepMemory();
  memory.delete(cacheKey);
  memory.set(cacheKey, {
    expiresAt: Date.now() + TTL_SECONDS * 1000,
    sources,
  });
  sweepMemory();
  if (hasUpstash) {
    try {
      await (await redis()).set(cacheKey, sources, { ex: TTL_SECONDS });
    } catch {}
  }
}

export async function readCachedEvidence(
  plan: EvidencePlan,
  entities: FinanceEntity[],
  revisions: EvidenceRevisions = {}
): Promise<EvidenceInput[]> {
  const inputs: EvidenceInput[] = [];
  for (const entity of entities) {
    const query = plan.queries.find(
      (candidate) =>
        (candidate.provider === "astra" || candidate.provider === "tavily") &&
        candidate.entityIds.includes(entity.id)
    );
    if (!query) continue;
    const criteria = criteriaFor(plan, entity.id);
    const sources = await readKey(
      key(entity.id, criteria, plan, revisions[entity.id])
    );
    const seen = new Set<string>();
    for (const source of sources) {
      if (seen.has(source.url)) continue;
      const actualCriteria = source.criteria.filter((criterion) =>
        criteria.includes(criterion)
      );
      if (actualCriteria.length === 0) continue;
      const matchingQueries = plan.queries.filter(
        (candidate) =>
          candidate.provider === source.kind &&
          candidate.entityIds.includes(entity.id) &&
          candidate.criteria.some((criterion) =>
            actualCriteria.includes(criterion)
          )
      );
      const matchingQuery =
        matchingQueries.find((candidate) => candidate.id === source.queryId) ??
        matchingQueries.sort(
          (left, right) =>
            (left.freshnessDays ?? Number.POSITIVE_INFINITY) -
            (right.freshnessDays ?? Number.POSITIVE_INFINITY)
        )[0];
      if (!matchingQuery) continue;
      const matchedCriteria = actualCriteria.filter((criterion) =>
        matchingQuery.criteria.includes(criterion)
      );
      if (matchedCriteria.length === 0) continue;
      seen.add(source.url);
      inputs.push({
        ...source,
        id: undefined,
        entityIds: [entity.id],
        criteria: matchedCriteria,
        queryId: matchingQuery.id,
        retrievedAt: new Date().toISOString(),
      } as EvidenceInput);
    }
  }
  return inputs;
}

export async function readCachedPublishedEvidence(
  plan: EvidencePlan,
  entities: FinanceEntity[]
): Promise<{ inputs: EvidenceInput[]; revisions: EvidenceRevisions }> {
  const revisions = Object.fromEntries(
    await Promise.all(
      entities.map(async (entity) => {
        if (!entity.ticker || entity.market === "web") {
          return [entity.id, MISSING_INTELLIGENCE_REVISION] as const;
        }
        try {
          const analysis = await readAnalysisDoc(entity.ticker);
          return [
            entity.id,
            analysis?.content_fingerprint ??
              `generation-${analysis?.generation ?? 0}`,
          ] as const;
        } catch {
          return [entity.id, MISSING_INTELLIGENCE_REVISION] as const;
        }
      })
    )
  );
  return {
    inputs: await readCachedEvidence(plan, entities, revisions),
    revisions,
  };
}

export async function writeCachedEvidence(
  plan: EvidencePlan,
  sources: EvidenceSource[],
  revisions: EvidenceRevisions = {}
): Promise<void> {
  const entityIds = [...new Set(sources.flatMap((source) => source.entityIds))];
  await Promise.all(
    entityIds.flatMap((entityId) => {
      const entitySources = sources
        .filter((source) => source.entityIds.includes(entityId))
        .slice(0, 4);
      const criteria = criteriaFor(plan, entityId);
      return [
        writeKey(
          key(entityId, criteria, plan, revisions[entityId]),
          entitySources
        ),
      ];
    })
  );
}

export function resetEvidenceCacheMemory(): void {
  memory.clear();
}

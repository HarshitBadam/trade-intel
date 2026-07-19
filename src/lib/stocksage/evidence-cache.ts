import "server-only";

import { hasUpstash } from "@/lib/config";
import type { EvidenceInput } from "./citations";
import type {
  EvidencePlan,
  EvidenceSource,
  FinanceEntity,
} from "./types";

const TTL_SECONDS = 15 * 60;
const memory = new Map<string, { expiresAt: number; sources: EvidenceSource[] }>();

async function redis() {
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

function freshnessBucket(plan: EvidencePlan): string {
  const days = Math.max(
    1,
    ...plan.queries
      .filter((query) => query.provider === "astra" || query.provider === "tavily")
      .map((query) => query.freshnessDays ?? 60)
  );
  return days <= 14 ? "14d" : days <= 60 ? "60d" : "long";
}

function criteriaKey(criteria: string[]): string {
  return [...new Set(criteria.map((item) => item.toLowerCase()))]
    .sort()
    .join("+") || "general";
}

function key(entityId: string, criteria: string[], plan: EvidencePlan): string {
  const entity = entityId.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-");
  return `stocksage:evidence:v1:${entity}:${criteriaKey(criteria)}:${freshnessBucket(plan)}`;
}

async function readKey(cacheKey: string): Promise<EvidenceSource[]> {
  if (hasUpstash) {
    try {
      const value = await (await redis()).get<EvidenceSource[]>(cacheKey);
      if (Array.isArray(value)) return value;
    } catch {}
  }
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
  memory.set(cacheKey, {
    expiresAt: Date.now() + TTL_SECONDS * 1000,
    sources,
  });
  if (hasUpstash) {
    try {
      await (await redis()).set(cacheKey, sources, { ex: TTL_SECONDS });
    } catch {}
  }
}

export async function readCachedEvidence(
  plan: EvidencePlan,
  entities: FinanceEntity[]
): Promise<EvidenceInput[]> {
  const inputs: EvidenceInput[] = [];
  for (const entity of entities) {
    const query = plan.queries.find(
      (candidate) =>
        (candidate.provider === "astra" || candidate.provider === "tavily") &&
        candidate.entityIds.includes(entity.id)
    );
    if (!query) continue;
    const keys = [
      key(entity.id, query.criteria, plan),
      key(entity.id, ["all"], plan),
    ];
    const sources = (await Promise.all(keys.map(readKey))).flat();
    const seen = new Set<string>();
    for (const source of sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      inputs.push({
        ...source,
        id: undefined,
        entityIds: [entity.id],
        criteria: query.criteria,
        queryId: query.id,
        retrievedAt: new Date().toISOString(),
      } as EvidenceInput);
    }
  }
  return inputs;
}

export async function writeCachedEvidence(
  plan: EvidencePlan,
  sources: EvidenceSource[]
): Promise<void> {
  const entityIds = [...new Set(sources.flatMap((source) => source.entityIds))];
  await Promise.all(
    entityIds.flatMap((entityId) => {
      const entitySources = sources
        .filter((source) => source.entityIds.includes(entityId))
        .slice(0, 4);
      const criteria = plan.queries
        .filter((query) => query.entityIds.includes(entityId))
        .flatMap((query) => query.criteria);
      return [
        writeKey(key(entityId, criteria, plan), entitySources),
        writeKey(key(entityId, ["all"], plan), entitySources),
      ];
    })
  );
}

export function resetEvidenceCacheMemory(): void {
  memory.clear();
}

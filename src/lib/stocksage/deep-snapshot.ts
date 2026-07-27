import "server-only";

import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  hasDeepResearch,
  STOCKSAGE_DEEP_SNAPSHOT_SECRET,
} from "@/lib/config";
import { safeSourceUrl } from "./citations";
import { detectCriteria } from "./conversation-attributes";
import type {
  ChatReply,
  ConversationState,
  DeepResearchOffer,
  EvidenceSource,
  FinanceEntity,
} from "./types";

const SnapshotSchema = z.object({
  version: z.literal(1),
  responseId: z.string().uuid(),
  workId: z.string().uuid(),
  question: z.string().min(1).max(1200),
  regularAnswer: z.string().min(1).max(5000),
  evidenceIds: z.array(z.string().max(40)).max(16),
  citationUrls: z.array(z.string().url()).max(16),
  entities: z
    .array(
      z.object({
        id: z.string().max(40),
        name: z.string().max(120),
        ticker: z.string().max(12).optional(),
        market: z.enum(["us", "web", "index", "au"]),
        private: z.boolean().optional(),
      })
    )
    .max(12),
  criteria: z.array(z.string().max(60)).max(8),
  horizon: z.string().max(120).optional(),
  jurisdiction: z.string().max(40).optional(),
  asOf: z.string().datetime(),
  stateVersion: z.literal(1),
  stateRevision: z.number().int().min(0),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type DeepResearchSnapshot = z.infer<typeof SnapshotSchema>;

export type DeepResearchAvailabilityReason =
  | "available_broad_evidence"
  | "available_single_criterion"
  | "no_valid_sources"
  | "insufficient_independent_sources"
  | "missing_criteria_coverage"
  | "missing_entity_coverage";

export type DeepResearchAvailability = {
  available: boolean;
  reason: DeepResearchAvailabilityReason;
  distinctSourceCount: number;
  coveredCriteria: string[];
};

export function isDeepResearchOfferAvailable(
  offer: DeepResearchOffer | undefined
): offer is DeepResearchOffer & { available: true } {
  return offer?.available === true;
}

const RESEARCH_CRITERIA = new Set([
  "dividends",
  "earnings",
  "growth",
  "outlook",
  "performance",
  "risk",
  "size",
  "valuation",
]);

function canonicalSourceUrl(value: string): string | null {
  const safe = safeSourceUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid|gclid|source)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

/**
 * Broad reports need independent evidence and criterion coverage. A focused
 * one-dimensional question may proceed from one relevant article; quotes and
 * fundamentals are intentionally absent because they never satisfy preflight.
 */
export function assessDeepResearchAvailability(args: {
  question: string;
  criteria: string[];
  sources: EvidenceSource[];
  entityIds?: string[];
}): DeepResearchAvailability {
  const explicitCriteria = detectCriteria(args.question).filter((criterion) =>
    RESEARCH_CRITERIA.has(criterion)
  );
  const requestedCriteria = [
    ...new Set(
      (explicitCriteria.length > 0 ? explicitCriteria : args.criteria).filter(
        (criterion) => RESEARCH_CRITERIA.has(criterion)
      )
    ),
  ];
  const byUrl = new Map<string, EvidenceSource>();
  for (const source of args.sources) {
    const url = canonicalSourceUrl(source.url);
    if (url && !byUrl.has(url)) byUrl.set(url, source);
  }
  const validSources = [...byUrl.values()];
  const coveredCriteria = requestedCriteria.filter((criterion) =>
    validSources.some((source) => source.criteria.includes(criterion))
  );
  if (validSources.length === 0) {
    return {
      available: false,
      reason: "no_valid_sources",
      distinctSourceCount: 0,
      coveredCriteria,
    };
  }
  const requiredEntities = [...new Set(args.entityIds ?? [])];
  if (
    requiredEntities.length > 1 &&
    requiredEntities.some(
      (entityId) =>
        !validSources.some((source) => source.entityIds.includes(entityId))
    )
  ) {
    return {
      available: false,
      reason: "missing_entity_coverage",
      distinctSourceCount: validSources.length,
      coveredCriteria,
    };
  }

  const broadReport =
    /\b(?:deep research|research|research report|report on)\b/i.test(
      args.question
    ) ||
    requestedCriteria.length >= 2 ||
    (/\b(?:catalysts?|outlook)\b/i.test(args.question) &&
      /\brisks?\b/i.test(args.question));

  if (
    requestedCriteria.length > 0 &&
    coveredCriteria.length < requestedCriteria.length
  ) {
    return {
      available: false,
      reason: "missing_criteria_coverage",
      distinctSourceCount: validSources.length,
      coveredCriteria,
    };
  }

  if (broadReport && validSources.length < 2) {
    return {
      available: false,
      reason: "insufficient_independent_sources",
      distinctSourceCount: validSources.length,
      coveredCriteria,
    };
  }

  return {
    available: true,
    reason: broadReport
      ? "available_broad_evidence"
      : "available_single_criterion",
    distinctSourceCount: validSources.length,
    coveredCriteria,
  };
}

function signature(payload: string): string {
  if (!STOCKSAGE_DEEP_SNAPSHOT_SECRET) {
    throw new Error("Deep Research snapshot signing is unavailable");
  }
  return createHmac("sha256", STOCKSAGE_DEEP_SNAPSHOT_SECRET)
    .update(payload)
    .digest("base64url");
}

export function createDeepResearchOffer(args: {
  question: string;
  reply: ChatReply;
  entities: FinanceEntity[];
  state: ConversationState;
  sources: EvidenceSource[];
  asOf: string;
}): { responseId: string; offer?: DeepResearchOffer } {
  const responseId = randomUUID();
  if (!hasDeepResearch || !args.reply.text.trim()) return { responseId };
  const workId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const citationUrls = (args.reply.citationUrls ?? [])
    .map(safeSourceUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, 16);
  const availability = assessDeepResearchAvailability({
    question: args.question,
    criteria: args.state.criteria,
    sources: args.sources,
    entityIds: args.entities.map((entity) => entity.id),
  });
  const snapshot: DeepResearchSnapshot = {
    version: 1,
    responseId,
    workId,
    question: args.question.slice(0, 1200),
    regularAnswer: args.reply.text.slice(0, 5000),
    evidenceIds: args.sources.map((source) => source.id).slice(0, 16),
    citationUrls,
    entities: args.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      ticker: entity.ticker,
      market: entity.market,
      private: entity.private,
    })),
    criteria: args.state.criteria,
    horizon: args.state.horizon,
    jurisdiction: args.state.jurisdiction,
    asOf: args.asOf,
    stateVersion: args.state.version,
    stateRevision: args.state.revision,
    createdAt,
    expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  return {
    responseId,
    offer: {
      token: `${payload}.${signature(payload)}`,
      workId,
      available: availability.available,
      ...(!availability.available
        ? {
            unavailableReason:
              "live research is refreshing, try again shortly",
          }
        : {}),
    },
  };
}

export function parseDeepResearchSnapshot(
  token: unknown
): DeepResearchSnapshot | null {
  if (typeof token !== "string" || token.length > 20_000) return null;
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra || !STOCKSAGE_DEEP_SNAPSHOT_SECRET) {
    return null;
  }
  const expected = signature(payload);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const parsed = SnapshotSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    );
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

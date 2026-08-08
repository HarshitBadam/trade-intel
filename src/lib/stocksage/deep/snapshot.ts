import "server-only";

import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  hasDeepQueue,
  hasDeepResearch,
  STOCKSAGE_DEEP_SNAPSHOT_SECRET,
} from "@/lib/config";
import { safeSourceUrl } from "../citations";
import { detectCriteria } from "../conversation-attributes";
import { primaryCalendar } from "../listing-capability";
import { defaultInterval } from "../temporal";
import type {
  ChatRoute,
  ChatReply,
  ConversationState,
  DeepResearchOffer,
  EvidenceSource,
  FinanceEntity,
  NamedGroupRef,
} from "../types";

const SnapshotEntityV1Schema = z.object({
  id: z.string().max(40),
  name: z.string().max(120),
  ticker: z.string().max(12).optional(),
  market: z.enum(["us", "web", "index", "au"]),
  private: z.boolean().optional(),
});

const SnapshotEntityV2Schema = SnapshotEntityV1Schema.extend({
  query: z.string().min(1).max(180),
  jurisdiction: z.string().max(40).optional(),
});

const SnapshotGroupSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  memberIds: z.array(z.string().min(1).max(40)).max(12),
  namedAtRevision: z.number().int().min(0).max(10_000),
});

const SnapshotIntervalSchema = z.object({
  version: z.literal(1),
  label: z.string().min(1).max(60),
  kind: z.enum(["session", "prior_session", "to_date", "trailing", "range"]),
  calendar: z.enum(["US", "AU"]),
  startSession: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endSession: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(["explicit", "inherited", "default"]),
  raw: z.string().max(60).optional(),
});

const SnapshotV1Schema = z.object({
  version: z.literal(1),
  responseId: z.string().uuid(),
  workId: z.string().uuid(),
  question: z.string().min(1).max(1200),
  regularAnswer: z.string().min(1).max(5000),
  evidenceIds: z.array(z.string().max(40)).max(16),
  citationUrls: z.array(z.string().url()).max(16),
  entities: z.array(SnapshotEntityV1Schema).max(12),
  criteria: z.array(z.string().max(60)).max(8),
  horizon: z.string().max(120).optional(),
  jurisdiction: z.string().max(40).optional(),
  asOf: z.string().datetime(),
  stateVersion: z.literal(1),
  stateRevision: z.number().int().min(0),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const SnapshotV2Schema = SnapshotV1Schema.omit({
  version: true,
  entities: true,
}).extend({
  version: z.literal(2),
  attemptId: z.string().uuid(),
  attempt: z.number().int().min(1).max(100),
  parentWorkId: z.string().uuid().optional(),
  route: z.enum(["current_finance", "comparison"]),
  entities: z.array(SnapshotEntityV2Schema).max(12),
  groups: z.array(SnapshotGroupSchema).max(12),
  intervals: z.array(SnapshotIntervalSchema).min(1).max(8),
  calendar: z.enum(["US", "AU"]),
});

const SnapshotSchema = z.discriminatedUnion("version", [
  SnapshotV1Schema,
  SnapshotV2Schema,
]);

export type DeepResearchSnapshotV1 = z.infer<typeof SnapshotV1Schema>;
export type DeepResearchSnapshotV2 = z.infer<typeof SnapshotV2Schema>;
export type DeepResearchSnapshot = z.infer<typeof SnapshotSchema>;

export type DeepResearchAttemptIdentity = {
  workId: string;
  attemptId: string;
  attempt: number;
};

export function deepResearchAttemptIdentity(
  snapshot: DeepResearchSnapshot
): DeepResearchAttemptIdentity {
  return snapshot.version === 2
    ? {
        workId: snapshot.workId,
        attemptId: snapshot.attemptId,
        attempt: snapshot.attempt,
      }
    : {
        workId: snapshot.workId,
        // A v1 token signed workId but predated explicit attempt identities.
        // Deriving the identity keeps its remaining 24-hour lifetime safe.
        attemptId: snapshot.workId,
        attempt: 1,
      };
}

export type DeepResearchAvailabilityReason =
  | "available_broad_evidence"
  | "available_single_criterion"
  | "available_retrieval_needed"
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
 * Existing evidence is a signal, not a prerequisite. Deep Research performs
 * its own broader retrieval, so a sparse regular answer is exactly when the
 * action should remain available for a resolved subject.
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
  const requiredEntities = [...new Set(args.entityIds ?? [])];
  const coveredCriteria = requestedCriteria.filter((criterion) =>
    validSources.some((source) => source.criteria.includes(criterion))
  );
  if (validSources.length === 0) {
    return {
      available: requiredEntities.length > 0,
      reason:
        requiredEntities.length > 0
          ? "available_retrieval_needed"
          : "no_valid_sources",
      distinctSourceCount: 0,
      coveredCriteria,
    };
  }
  if (
    requiredEntities.length > 1 &&
    requiredEntities.some(
      (entityId) =>
        !validSources.some((source) => source.entityIds.includes(entityId))
    )
  ) {
    return {
      available: true,
      reason: "available_retrieval_needed",
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
      available: true,
      reason: "available_retrieval_needed",
      distinctSourceCount: validSources.length,
      coveredCriteria,
    };
  }

  if (broadReport && validSources.length < 2) {
    return {
      available: true,
      reason: "available_retrieval_needed",
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

function signSnapshot(snapshot: DeepResearchSnapshot): string {
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

function v2Context(args: {
  entities: FinanceEntity[];
  state: ConversationState;
  asOf: string;
}): {
  route: Extract<ChatRoute, "current_finance" | "comparison">;
  entities: DeepResearchSnapshotV2["entities"];
  groups: NamedGroupRef[];
  intervals: DeepResearchSnapshotV2["intervals"];
  calendar: DeepResearchSnapshotV2["calendar"];
} {
  const route = args.entities.length > 1 ? "comparison" : "current_finance";
  const calendar =
    args.state.intervals?.[0]?.calendar ?? primaryCalendar(args.entities);
  const intervals =
    args.state.intervals && args.state.intervals.length > 0
      ? args.state.intervals
      : [defaultInterval(calendar, new Date(args.asOf))];
  return {
    route,
    entities: args.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      query: entity.query,
      ticker: entity.ticker,
      market: entity.market,
      jurisdiction: entity.jurisdiction,
      private: entity.private,
    })),
    groups: args.state.groups ?? [],
    intervals,
    calendar,
  };
}

export function createDeepResearchOffer(args: {
  question: string;
  reply: ChatReply;
  entities: FinanceEntity[];
  state: ConversationState;
  sources: EvidenceSource[];
  asOf: string;
  eligible?: boolean;
  /** Test seam for the mocked queue integration; production uses config. */
  queueReady?: boolean;
}): { responseId: string; offer?: DeepResearchOffer } {
  const responseId = randomUUID();
  if (
    args.eligible === false ||
    !hasDeepResearch ||
    !(args.queueReady ?? hasDeepQueue) ||
    !args.reply.text.trim()
  ) {
    return { responseId };
  }
  const workId = randomUUID();
  const attemptId = randomUUID();
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
  const frozen = v2Context({
    entities: args.entities,
    state: args.state,
    asOf: args.asOf,
  });
  const snapshot: DeepResearchSnapshotV2 = {
    version: 2,
    responseId,
    workId,
    attemptId,
    attempt: 1,
    route: frozen.route,
    question: args.question.slice(0, 1200),
    regularAnswer: args.reply.text.slice(0, 5000),
    evidenceIds: args.sources.map((source) => source.id).slice(0, 16),
    citationUrls,
    entities: frozen.entities,
    groups: frozen.groups,
    criteria: args.state.criteria,
    horizon: args.state.horizon,
    jurisdiction: args.state.jurisdiction,
    intervals: frozen.intervals,
    calendar: frozen.calendar,
    asOf: args.asOf,
    stateVersion: args.state.version,
    stateRevision: args.state.revision,
    createdAt,
    expiresAt,
  };
  return {
    responseId,
    offer: {
      token: signSnapshot(snapshot),
      workId,
      available: availability.available,
      ...(!availability.available
        ? {
            unavailableReason:
              "Research deeper opens for a resolved company, index, or finance subject.",
          }
        : {}),
    },
  };
}

/**
 * Retries are new signed attempts, never QStash redeliveries of an old
 * deduplication identity. The original frozen context is copied verbatim.
 */
export function reissueDeepResearchSnapshot(
  snapshot: DeepResearchSnapshot
): { snapshot: DeepResearchSnapshotV2; token: string } {
  const workId = randomUUID();
  const attemptId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const legacyEntities: FinanceEntity[] =
    snapshot.version === 2
      ? snapshot.entities.map((entity) => ({ ...entity }))
      : snapshot.entities.map((entity) => ({
          ...entity,
          query: entity.ticker ?? entity.name,
          jurisdiction: snapshot.jurisdiction,
        }));
  const frozen =
    snapshot.version === 2
      ? {
          route: snapshot.route,
          entities: snapshot.entities,
          groups: snapshot.groups,
          intervals: snapshot.intervals,
          calendar: snapshot.calendar,
        }
      : v2Context({
          entities: legacyEntities,
          state: {
            version: 1,
            revision: snapshot.stateRevision,
            entities: legacyEntities,
            explicitEntitySet: legacyEntities.map((entity) => entity.id),
            criteria: snapshot.criteria,
            horizon: snapshot.horizon,
            jurisdiction: snapshot.jurisdiction,
          },
          asOf: snapshot.asOf,
        });
  const next: DeepResearchSnapshotV2 = {
    ...snapshot,
    version: 2,
    workId,
    attemptId,
    attempt: snapshot.version === 2 ? snapshot.attempt + 1 : 2,
    parentWorkId: snapshot.workId,
    route: frozen.route,
    entities: frozen.entities,
    groups: frozen.groups,
    intervals: frozen.intervals,
    calendar: frozen.calendar,
    createdAt: now.toISOString(),
    expiresAt,
  };
  return { snapshot: next, token: signSnapshot(next) };
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

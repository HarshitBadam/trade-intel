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
        market: z.enum(["us", "web"]),
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
    offer: { token: `${payload}.${signature(payload)}`, workId },
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

import { z } from "zod";
import type { TemporalInterval } from "./temporal";

export type ChatTurn = {
  role: "user" | "ai";
  text: string;
};

export type ChatRequest = {
  message: string;
  sessionId?: string;
  history: ChatTurn[];
  state?: ConversationState;
};

export type ChatDataStatus = "full" | "limited" | "unavailable";

export type ChatPresentationMode =
  | "social"
  | "clarification"
  | "current_finance"
  | "comparison"
  | "limited_evidence"
  | "no_evidence";

export type ChatReply = {
  text: string;
  live: boolean;
  kind?: "answer" | "error";
  errorCode?: "unauthorized" | "rate_limited" | "invalid_request";
  retryable?: boolean;
  citationUrls?: string[];
  responseId?: string;
  state?: ConversationState;
  dataStatus?: ChatDataStatus;
  presentationMode?: ChatPresentationMode;
  presentationReason?: string;
};

export type FinanceMarket = "us" | "web" | "index" | "au";

export type FinanceEntity = {
  id: string;
  name: string;
  query: string;
  ticker?: string;
  market: FinanceMarket;
  jurisdiction?: string;
  private?: boolean;
};

export type NamedGroupRef = {
  id: string;
  label: string;
  memberIds: string[];
  namedAtRevision: number;
};

export type ConversationState = {
  version: 1;
  revision: number;
  entities: FinanceEntity[];
  explicitEntitySet: string[];
  criteria: string[];
  horizon?: string;
  jurisdiction?: string;
  safetyRepliesUsed?: string[];
  groups?: NamedGroupRef[];
  focusEntityIds?: string[];
  intervals?: TemporalInterval[];
  pendingClarification?: string;
};

export type SourceKind = "astra" | "tavily";

export type EvidenceSource = {
  id: string;
  kind: SourceKind;
  title: string;
  outlet: string;
  publishedAt?: string;
  url: string;
  excerpt: string;
  score?: number;
  entityIds: string[];
  criteria: string[];
  retrievedAt: string;
  queryId?: string;
  ticker?: string;
  event?: string;
  importance?: string;
  keyObservations?: string;
  sentiment?: string;
  sentimentReasoning?: string;
  relevanceScore?: number;
};

export type EvidenceQuery = {
  id: string;
  provider: SourceKind;
  query: string;
  entityIds: string[];
  tickers: string[];
  criteria: string[];
  freshnessDays?: number;
  topic: "general" | "news";
  limit: number;
};

export type DomainReasonCode =
  | "allowed_finance"
  | "social"
  | "out_of_scope"
  | "prohibited_gambling"
  | "prohibited_financial_misconduct"
  | "prohibited_external_action"
  | "prohibited_crypto_promotion"
  | "crypto_risk_only"
  | "ambiguous_crypto"
  | "high_stakes_finance"
  | "explicit_self_harm"
  | "acute_distress"
  | "threat_of_violence";

export type DomainPolicyDecision = {
  action: "allow" | "respond" | "clarify";
  reasonCode: DomainReasonCode;
  response?: string;
};

export const MAX_MESSAGE_CHARS = 1200;
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_TURN_CHARS = 1000;
const MAX_HISTORY_TOTAL_CHARS = 6000;
const MAX_SESSION_CHARS = 128;

const EntitySchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  query: z.string().min(1).max(180),
  ticker: z.string().min(1).max(12).optional(),
  market: z.enum(["us", "web", "index", "au"]),
  jurisdiction: z.string().max(40).optional(),
  private: z.boolean().optional(),
});

const GroupSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  memberIds: z.array(z.string().min(1).max(40)).max(12),
  namedAtRevision: z.number().int().min(0).max(10_000),
});

const IntervalSchema = z.object({
  version: z.literal(1),
  label: z.string().min(1).max(60),
  kind: z.enum(["session", "prior_session", "to_date", "trailing", "range"]),
  calendar: z.enum(["US", "AU"]),
  startSession: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endSession: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(["explicit", "inherited", "default"]),
  raw: z.string().max(60).optional(),
});

const ConversationStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).max(10_000),
  entities: z.array(EntitySchema).max(12),
  explicitEntitySet: z.array(z.string().min(1).max(40)).max(12),
  criteria: z.array(z.string().min(1).max(60)).max(8),
  horizon: z.string().max(120).optional(),
  jurisdiction: z.string().max(40).optional(),
  safetyRepliesUsed: z.array(z.string().min(1).max(60)).max(24).optional(),
  groups: z.array(GroupSchema).max(4).optional(),
  focusEntityIds: z.array(z.string().min(1).max(40)).max(12).optional(),
  intervals: z.array(IntervalSchema).max(8).optional(),
  pendingClarification: z.string().max(300).optional(),
});

type ParseResult =
  | { ok: true; value: ChatRequest }
  | { ok: false; error: string };

function recentHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const valid = value
    .filter(
      (turn): turn is ChatTurn =>
        Boolean(turn) &&
        typeof turn === "object" &&
        ((turn as ChatTurn).role === "user" ||
          (turn as ChatTurn).role === "ai") &&
        typeof (turn as ChatTurn).text === "string"
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      text: turn.text.trim().slice(0, MAX_HISTORY_TURN_CHARS),
    }))
    .filter((turn) => turn.text.length > 0);

  let used = 0;
  const bounded: ChatTurn[] = [];
  for (let i = valid.length - 1; i >= 0; i -= 1) {
    const remaining = MAX_HISTORY_TOTAL_CHARS - used;
    if (remaining <= 0) break;
    const text = valid[i].text.slice(-remaining);
    bounded.unshift({ role: valid[i].role, text });
    used += text.length;
  }
  return bounded;
}

export function parseChatRequest(value: unknown): ParseResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Invalid chat request." };
  }

  const input = value as Record<string, unknown>;
  if (typeof input.message !== "string") {
    return { ok: false, error: "Enter a message." };
  }

  const message = input.message.trim();
  if (!message) return { ok: false, error: "Enter a message." };
  if (message.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `Keep messages under ${MAX_MESSAGE_CHARS} characters.`,
    };
  }

  const rawSession =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const sessionId =
    rawSession &&
    rawSession.length <= MAX_SESSION_CHARS &&
    /^[A-Za-z0-9_-]+$/.test(rawSession)
      ? rawSession
      : undefined;
  const parsedState = ConversationStateSchema.safeParse(input.state);

  return {
    ok: true,
    value: {
      message,
      sessionId,
      history: recentHistory(input.history),
      state: parsedState.success ? parsedState.data : undefined,
    },
  };
}

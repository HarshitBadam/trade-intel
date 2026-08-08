import { z } from "zod";
import type { LatencyClass, RouteClass } from "./telemetry";
import type { MarketCalendar, TemporalInterval } from "./temporal";

export type ChatRoute =
  | "social"
  | "general"
  | "out_of_scope"
  | "refused"
  | "stable_finance"
  | "current_finance"
  | "comparison"
  | "clarify"
  | "safety_support";

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

// Data health: full, limited verified data, or unavailable.
export type ChatDataStatus = "full" | "limited" | "unavailable";

/**
 * How the widget should render a reply, using the architecture's stable
 * presentation buckets rather than generic instant/answer labels. Additive
 * and backward-compatible: every existing consumer that ignores these
 * fields keeps working exactly as before. Only the unified engine
 * (`engine.ts`) currently populates them; call sites that skip it (e.g. raw
 * `immediateResponse` for crisis/refusal text) leave them undefined.
 * `deep_pending`/`deep_failed` are client-only states the widget derives from
 * local Deep Research progress (see `effectivePresentationMode` in
 * `components/chat/presentation.ts`); the server never sets them.
 */
export type ChatPresentationMode =
  | "social"
  | "clarification"
  | "stable_finance"
  | "current_finance"
  | "comparison"
  | "limited_evidence"
  | "no_evidence"
  | "deep_pending"
  | "deep_failed";

/** One structured choice the widget can render for a clarification turn. */
export type ClarificationChoice = {
  id: string;
  label: string;
};

export type ChatReply = {
  text: string;
  live: boolean;
  kind?: "answer" | "error";
  errorCode?: "unauthorized" | "rate_limited" | "invalid_request";
  retryable?: boolean;
  citationUrls?: string[];
  responseId?: string;
  deepResearch?: DeepResearchOffer;
  state?: ConversationState;
  dataStatus?: ChatDataStatus;
  /** Optional, backward-compatible presentation hints for the widget. */
  presentationMode?: ChatPresentationMode;
  presentationReason?: string;
  clarificationChoices?: ClarificationChoice[];
};

// ASX quotes use native Yahoo data; Stooq/ADRs remain labeled fallbacks.
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

/**
 * A group the user named as a unit ("the Aussie Big Four"). Group identity is
 * kept beside the flat entity list because a later "them" can refer to the
 * last named group rather than to the whole prior comparison.
 */
export type NamedGroupRef = {
  id: string;
  label: string;
  memberIds: string[];
  /** State revision at which the group was named. */
  namedAtRevision: number;
};

export type ConversationState = {
  version: 1;
  revision: number;
  entities: FinanceEntity[];
  explicitEntitySet: string[];
  criteria: string[];
  /** Legacy wire format retained while clients migrate to `intervals`. */
  horizon?: string;
  jurisdiction?: string;
  safetyRepliesUsed?: string[];
  /** Ordered named-group reference frames, oldest first. */
  groups?: NamedGroupRef[];
  /** The subset the next bare pronoun should resolve to. */
  focusEntityIds?: string[];
  /** Normalized market-calendar intervals for this turn. */
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

export type EvidenceRejectionReason =
  | "low_provider_score"
  | "unsafe_authority"
  | "stale"
  | "stale_content"
  | "entity_mismatch"
  | "missing_entity"
  | "criterion_mismatch"
  | "duplicate"
  | "invalid_source";

export type EvidenceDiagnostics = {
  inputCount: number;
  acceptedCount: number;
  cacheHitCount: number;
  rejected: Partial<Record<EvidenceRejectionReason, number>>;
};

export type EvidenceBundle = {
  version: 1;
  asOf: string;
  entityIds: string[];
  criteria: string[];
  horizon?: string;
  quotes: import("@/lib/market-data").ChatQuote[];
  fundamentals: import("@/lib/market-data").ChatFundamentals[];
  sources: EvidenceSource[];
  criteriaCoverage: Record<string, string[]>;
  freshness: Record<string, string | undefined>;
  proxyIdentity: Record<
    string,
    { symbol: string; kind: "etf" | "adr"; note?: string }
  >;
  diagnostics: EvidenceDiagnostics;
};

export type EvidenceProvider =
  | "quotes"
  | "market_proxy"
  | "astra"
  | "tavily"
  | "stooq";

export type EvidenceQuery = {
  id: string;
  provider: EvidenceProvider;
  query: string;
  entityIds: string[];
  tickers: string[];
  criteria: string[];
  freshnessDays?: number;
  topic: "general" | "news";
  limit: number;
};

export type EvidencePlan = {
  version: 1;
  /** Additive for compatibility with persisted/test v1 plans; planner always sets it. */
  depth?: "regular" | "deep";
  route: ChatRoute;
  asOf: string;
  queries: EvidenceQuery[];
  requiredEntityIds: string[];
  criteria: string[];
  explicitCriteria?: string[];
  /** True when sources are being used to explain a price move in this window. */
  causal?: boolean;
  /** Legacy label; `intervals` carries the normalized market-calendar window. */
  horizon?: string;
  intervals?: TemporalInterval[];
};

export type RouteDecision = {
  route: ChatRoute;
  reasonCode: string;
  retrievalRequired: boolean;
  deepEligible: boolean;
  clarification?: string;
};

/**
 * The single authoritative classification of a turn. Every answer executor
 * consumes a frozen decision; none of them may re-run policy or routing.
 */
export type TurnDecisionKind =
  | "supported_stable"
  | "supported_current"
  | "supported_comparison"
  | "high_stakes_finance"
  | "ambiguous"
  | "out_of_scope"
  | "prohibited"
  | "safety_support"
  | "social";

export type TurnDecision = {
  readonly version: 1;
  readonly kind: TurnDecisionKind;
  /** Legacy route, preserved so existing consumers and telemetry keep working. */
  readonly route: ChatRoute;
  readonly reasonCode: string;
  readonly latencyClass: LatencyClass;
  readonly routeClass: RouteClass;
  /** No executor may call a market or web provider when this is false. */
  readonly retrievalAuthorized: boolean;
  /** Model synthesis may shape wording only when this is true. */
  readonly synthesisAuthorized: boolean;
  readonly deepEligible: boolean;
  readonly retryEligible: boolean;
  /**
   * False only where the reply is itself the safe output (crisis, hard safety
   * floor, refusal copy); every other turn joins the classifier verdict before
   * publishing.
   */
  readonly safetyRailRequired: boolean;
  /** Set for instant routes that answer without any executor work. */
  readonly immediateText?: string;
  readonly clarification?: string;
};

export type TurnContext = {
  readonly version: 1;
  /** NFKC-normalized message the decision was made from. */
  readonly message: string;
  readonly state: ConversationState;
  /** Ordered active entities for this turn. */
  readonly entities: FinanceEntity[];
  /** The subset a bare pronoun currently refers to. */
  readonly focusEntities: FinanceEntity[];
  readonly groups: NamedGroupRef[];
  readonly intervals: TemporalInterval[];
  readonly calendar: MarketCalendar;
  readonly criteria: string[];
  readonly jurisdiction?: string;
};

export type Turn = {
  readonly decision: TurnDecision;
  readonly context: TurnContext;
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

export type DeepResearchOffer = {
  token: string;
  workId: string;
  // False when research providers cannot supply evidence for these subjects.
  available: boolean;
  unavailableReason?: string;
};

export type DeepResearchReply = {
  workId: string;
  status: "success" | "failure";
  text?: string;
  citationUrls?: string[];
  retryable?: boolean;
  /**
   * Set only when `status: "failure"` represents a transient admission
   * denial (rate limit) or an auth gate, not a terminal job outcome. The
   * widget uses this to decide whether to retry the same work automatically
   * versus surface a definite stop. Absent for every real job failure.
   */
  errorCode?: "unauthorized" | "rate_limited";
  /** Present only alongside `errorCode: "rate_limited"`: how long to wait before retrying. */
  retryAfterMs?: number;
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
  intervals: z.array(IntervalSchema).max(4).optional(),
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

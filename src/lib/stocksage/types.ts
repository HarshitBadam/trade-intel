export type ChatMode = "regular" | "deep";

export type ChatIntent =
  | "conversation"
  | "help"
  | "thanks"
  | "company_update"
  | "comparison"
  | "macro"
  | "general_finance"
  | "deep_research";

export type ChatTurn = {
  role: "user" | "ai";
  text: string;
};

export type ChatRequest = {
  message: string;
  mode: ChatMode;
  sessionId?: string;
  history: ChatTurn[];
};

export type ChatReply = {
  text: string;
  live: boolean;
  retryable?: boolean;
  citationUrls?: string[];
};

export type FinanceEntity = {
  name: string;
  query: string;
  ticker?: string;
  market: "us" | "web";
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
};

export const MAX_MESSAGE_CHARS = 1200;
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_TURN_CHARS = 1000;
const MAX_HISTORY_TOTAL_CHARS = 6000;
const MAX_SESSION_CHARS = 128;

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
  if (input.mode !== "regular" && input.mode !== "deep") {
    return { ok: false, error: "Choose regular or Deep Research mode." };
  }
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

  return {
    ok: true,
    value: {
      message,
      mode: input.mode,
      sessionId,
      history: recentHistory(input.history),
    },
  };
}

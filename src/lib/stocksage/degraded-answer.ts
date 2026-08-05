import { immediateResponse } from "./chat-shared";
import type { ChatReply, ChatRequest, FinanceEntity, Turn } from "./types";

const DEGRADED_RESPONSE =
  "Name the company, metric, and time period, and I’ll return only matched dated evidence.";

function outageFloor(entities: FinanceEntity[]): string {
  if (entities.length === 0 || !entities.every((entity) => entity.private)) {
    return DEGRADED_RESPONSE;
  }
  const names = entities.map((entity) => entity.name);
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names[0];
  return `${list} ${names.length === 1 ? "is" : "are"} privately held, so the relevant lens is business performance, financing, growth, and risk rather than public-share returns. Name the dimension you want analyzed.`;
}

/** Renders a deterministic outage answer from the already-frozen turn. */
export function answerDegraded(
  request: ChatRequest,
  startedAt: number,
  turn: Turn
): ChatReply {
  const entities =
    turn.context.entities.length > 0
      ? turn.context.entities
      : turn.context.state.entities;
  if (turn.decision.immediateText) {
    return immediateResponse({
      text: turn.decision.immediateText,
      state: turn.context.state,
      route: turn.decision.route,
      reasonCode: turn.decision.reasonCode,
      startedAt,
      decision: turn.decision,
    });
  }
  return immediateResponse({
    text: outageFloor(entities),
    state: turn.context.state,
    route: "general",
    reasonCode: "all_llm_lanes_unavailable",
    startedAt,
    retryable: true,
    dataStatus: "unavailable",
  });
}

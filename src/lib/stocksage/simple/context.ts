import type { ChatRequest } from "../types";

export function compactHistory(request: ChatRequest): string {
  return request.history
    .slice(-6)
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.slice(0, 700)}`
    )
    .join("\n");
}

export function isoToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function semanticContext(
  request: ChatRequest,
  now = new Date()
): string {
  const entities = request.state?.entities.map((entity) => ({
    name: entity.name,
    ticker: entity.ticker,
    private: entity.private,
  }));
  return JSON.stringify({
    today: isoToday(now),
    activeEntities: entities ?? [],
    focusEntityIds: request.state?.focusEntityIds ?? [],
    priorIntervals: request.state?.intervals ?? [],
    conversation: compactHistory(request),
    currentMessage: request.message,
  });
}

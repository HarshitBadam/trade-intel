import type {
  ConversationState,
  FinanceEntity,
} from "./types";

const CRITERIA = new Set([
  "valuation",
  "performance",
  "dividends",
  "growth",
  "risk",
  "outlook",
  "earnings",
  "news",
  "size",
]);
const JURISDICTIONS = new Set([
  "Australia",
  "United States",
  "ASX",
  "London Stock Exchange",
  "Toronto Stock Exchange",
  "Hong Kong Stock Exchange",
  "Tokyo Stock Exchange",
  "National Stock Exchange of India",
  "Bombay Stock Exchange",
]);

export function sanitizeConversationState(
  previous: ConversationState,
  canonicalize: (entity: FinanceEntity) => FinanceEntity | null
): ConversationState {
  const entities = previous.entities
    .map(canonicalize)
    .filter((entity): entity is FinanceEntity => Boolean(entity))
    .slice(0, 8);
  const ids = new Set(entities.map((entity) => entity.id));
  const horizon =
    previous.horizon &&
    /^(?:today|yesterday|this (?:week|month|quarter|year)|last (?:few days|week|month|quarter|year)|(?:past|last|next|over) \d+ (?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|[135][ -]?year)$/i.test(
      previous.horizon
    )
      ? previous.horizon
      : undefined;
  return {
    version: 1,
    revision: Math.min(previous.revision, 10_000),
    entities,
    explicitEntitySet: previous.explicitEntitySet
      .filter((id) => ids.has(id))
      .slice(0, 8),
    criteria: previous.criteria
      .filter((criterion) => CRITERIA.has(criterion))
      .slice(0, 8),
    horizon,
    jurisdiction:
      previous.jurisdiction && JURISDICTIONS.has(previous.jurisdiction)
        ? previous.jurisdiction
        : undefined,
  };
}

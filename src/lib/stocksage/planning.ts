import type {
  ChatRoute,
  ConversationState,
  EvidencePlan,
  EvidenceQuery,
  FinanceEntity,
} from "./types";

const DEFAULT_COMPARISON_CRITERIA = [
  "valuation",
  "performance",
  "outlook",
  "risk",
];

function isPriceOnly(message: string): boolean {
  return (
    /\b(?:trading at|share price|stock price|price now|current price)\b/i.test(
      message
    ) &&
    !/\b(?:earnings|revenue|profit|margin|outlook|risk|news|update|guidance)\b/i.test(
      message
    )
  );
}

function historicalPeriod(message: string): boolean {
  return /\b(?:yesterday|last (?:week|month|quarter|year)|(?:past|last|over) \d+ (?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2})\b/i.test(
    message
  );
}

function evidenceFreshnessDays(message: string): number | undefined {
  if (/\blast year\b/i.test(message)) return 400;
  if (/\blast quarter\b/i.test(message)) return 180;
  if (/\blast month\b/i.test(message)) return 90;
  if (/\blast week\b/i.test(message)) return 30;
  if (/\byesterday\b/i.test(message)) return 14;
  return historicalPeriod(message) ? undefined : 14;
}

function query(
  id: string,
  provider: EvidenceQuery["provider"],
  text: string,
  entities: FinanceEntity[],
  criteria: string[],
  topic: EvidenceQuery["topic"],
  limit: number,
  freshnessDays?: number
): EvidenceQuery {
  return {
    id,
    provider,
    query: text,
    entityIds: entities.map((entity) => entity.id),
    tickers: entities
      .map((entity) => entity.ticker)
      .filter((ticker): ticker is string => Boolean(ticker)),
    criteria,
    freshnessDays,
    topic,
    limit,
  };
}

export function planEvidence(args: {
  route: ChatRoute;
  message: string;
  entities: FinanceEntity[];
  state: ConversationState;
  asOf?: string;
}): EvidencePlan {
  const asOf = args.asOf ?? new Date().toISOString();
  const queries: EvidenceQuery[] = [];
  const us = args.entities.filter(
    (entity) => entity.market === "us" && entity.ticker
  );
  const web = args.entities.filter((entity) => entity.market === "web");
  const entityContext = args.entities.map((entity) => entity.query).join("; ");
  const groundedQuery = entityContext
    ? `${args.message} Context: ${entityContext}`
    : args.message;
  const currentCriteria = /\b(?:earnings|revenue|profit|margin)\b/i.test(
    args.message
  )
    ? ["earnings"]
    : ["current developments"];
  const freshnessDays = evidenceFreshnessDays(args.message);
  const historical = historicalPeriod(args.message);

  if (args.route === "current_finance") {
    if (us.length > 0 && !historical) {
      queries.push(
        query("quotes-current", "quotes", args.message, us, ["price"], "news", 4)
      );
    }
    if (!isPriceOnly(args.message) && us.length > 0) {
      queries.push(
        query(
          "astra-current",
          "astra",
          args.message,
          us,
          currentCriteria,
          "news",
          6,
          freshnessDays
        )
      );
    }
    if (!isPriceOnly(args.message) || web.length > 0 || args.entities.length === 0) {
      const targets = web.length > 0 ? web : args.entities;
      queries.push(
        query(
          "tavily-current",
          "tavily",
          groundedQuery,
          targets,
          currentCriteria,
          "news",
          5,
          freshnessDays
        )
      );
    }
  }

  if (args.route === "comparison") {
    const criteria =
      args.state.criteria.length > 0
        ? args.state.criteria
        : DEFAULT_COMPARISON_CRITERIA;
    const topic = /\b(?:today|yesterday|current|recent|latest|earnings|regulat|legal|last|past|over|between)\b/i.test(
      args.message
    )
      ? "news"
      : "general";
    if (us.length > 0 && !historical && args.entities.length < 8) {
      queries.push(
        query(
          "quotes-comparison",
          "quotes",
          args.message,
          us,
          criteria,
          "general",
          Math.min(8, us.length)
        )
      );
    }
    for (const entity of args.entities) {
      queries.push(
        query(
          `tavily-${entity.id.replace(/[^a-z0-9]+/gi, "-")}`,
          "tavily",
          `${entity.query} compare ${criteria.join(", ")}`,
          [entity],
          criteria,
          topic,
          3,
          topic === "news" ? freshnessDays : undefined
        )
      );
    }
  }

  return {
    version: 1,
    route: args.route,
    asOf,
    queries,
    requiredEntityIds:
      args.route === "comparison"
        ? args.entities.map((entity) => entity.id)
        : [],
    criteria:
      args.route === "comparison"
        ? args.state.criteria.length > 0
          ? args.state.criteria
          : DEFAULT_COMPARISON_CRITERIA
        : [],
  };
}

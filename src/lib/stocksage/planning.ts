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
  return /\b(?:yesterday|last (?:few days|week|month|quarter|year)|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|(?:past|last|over) \d+ (?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|(?:on|since|before|after)\s+\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\b/i.test(
    message
  );
}

function evidenceFreshnessDays(message: string): number | undefined {
  const isoDate = message.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (isoDate) {
    const target = Date.parse(`${isoDate}T00:00:00.000Z`);
    if (Number.isFinite(target)) {
      return Math.max(
        14,
        Math.min(3650, Math.ceil((Date.now() - target) / 86_400_000) + 14)
      );
    }
  }
  if (/\blast year\b/i.test(message)) return 400;
  if (/\blast quarter\b/i.test(message)) return 120;
  if (/\blast month\b/i.test(message)) return 45;
  if (/\blast week\b/i.test(message)) return 14;
  if (
    /\blast few days\b|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|\bthe other day\b/i.test(
      message
    )
  ) {
    return 7;
  }
  if (/\byesterday\b/i.test(message)) return 3;
  return historicalPeriod(message) ? undefined : 14;
}

function supportsTrailingQuote(message: string): boolean {
  return /\b(?:today|yesterday|last (?:few days|week|month|year)|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|over the last (?:few days|week|month|year)|[135]\s*[- ]?year)\b/i.test(
    message
  );
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
  const fortuneRanking =
    /\bfortune\s*(?:100|500)\b/i.test(args.message) ||
    args.entities.some((entity) => /^Fortune (?:100|500)$/.test(entity.name));
  const currentCriteria = fortuneRanking
    ? ["revenue ranking"]
    : /\b(?:earnings|revenue|profit|margin)\b/i.test(args.message)
      ? ["earnings"]
      : args.state.criteria.length > 0
        ? args.state.criteria
        : historicalPeriod(args.message)
          ? ["performance"]
          : ["current developments"];
  const groundedQuery = [
    args.message,
    entityContext ? `Context: ${entityContext}` : "",
    `Focus: ${currentCriteria.join(", ")}`,
    args.state.horizon ? `Period: ${args.state.horizon}` : "",
    fortuneRanking
      ? `Use the latest official Fortune ranking available as of ${new Date().getUTCFullYear()}. Prefer fortune.com or fortunemedia.mediaroom.com`
      : currentCriteria.includes("earnings")
        ? "Prefer the company investor-relations release, SEC filing, exchange disclosure, or Reuters"
      : "",
  ]
    .filter(Boolean)
    .join(". ");
  const freshnessDays = fortuneRanking
    ? 550
    : evidenceFreshnessDays(args.message);
  const historical = historicalPeriod(args.message);

  if (args.route === "current_finance") {
    if (us.length > 0 && (!historical || supportsTrailingQuote(args.message))) {
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
    if (
      !isPriceOnly(args.message) ||
      historical ||
      web.length > 0 ||
      args.entities.length === 0
    ) {
      const targets = web.length > 0 ? web : args.entities;
      if (targets.length > 1) {
        for (const entity of targets.slice(0, 5)) {
          queries.push(
            query(
              `tavily-current-${entity.id.replace(/[^a-z0-9]+/gi, "-")}`,
              "tavily",
              `${entity.query} ${currentCriteria.join(" ")}. Context: ${args.message.slice(0, 160)}`,
              [entity],
              currentCriteria,
              fortuneRanking ? "general" : "news",
              3,
              freshnessDays
            )
          );
        }
      } else {
        queries.push(
          query(
            "tavily-current",
            "tavily",
            groundedQuery,
            targets,
            currentCriteria,
            fortuneRanking ? "general" : "news",
            5,
            freshnessDays
          )
        );
      }
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
    if (
      us.length > 0 &&
      (!historical || supportsTrailingQuote(args.message)) &&
      args.entities.length <= 8
    ) {
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
          `${entity.query} ${criteria.join(" ")}. Context: ${args.message.slice(0, 160)}`,
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

import { listingCapability } from "../listing-capability";
import { isMoveCauseAsk } from "../intent";
import { describeInterval, type TemporalInterval } from "../temporal";
import type {
  ChatRoute,
  ConversationState,
  EvidencePlan,
  EvidenceQuery,
  FinanceEntity,
} from "../types";

const DEFAULT_COMPARISON_CRITERIA = [
  "valuation",
  "performance",
  "growth",
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
  return /\b(?:yesterday|this (?:week|month|year)|month[- ]to[- ]date|mtd|trailing month|ytd|year[- ]to[- ]date|last (?:few days|week|month|quarter|year)|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|(?:past|last|over) \d+ (?:days?|weeks?|months?|years?)|over the last (?:day|week|month|quarter|year)|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|(?:on|since|before|after)\s+\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\b/i.test(
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

// Astra stores ~90 days; use wider history except for explicit today/yesterday asks.
function astraFreshnessDays(
  message: string,
  freshnessDays: number | undefined,
  moveCause = false
): number | undefined {
  if (moveCause) return freshnessDays ?? 4;
  if (/\b(?:today|yesterday|breaking|right now)\b/i.test(message)) {
    return freshnessDays ?? 7;
  }
  return freshnessDays === undefined ? undefined : Math.max(freshnessDays, 60);
}

function marketQuoteEligible(entities: FinanceEntity[]): FinanceEntity[] {
  return entities.filter(
    (entity) =>
      entity.ticker &&
      ["primary_asx", "adr_proxy", "etf_proxy", "delayed_index"].includes(
        listingCapability(entity).quoteStrategy
      )
  );
}

function supportsTrailingQuote(message: string): boolean {
  return /\b(?:today|yesterday|this (?:week|month|year)|month[- ]to[- ]date|mtd|trailing month|ytd|year[- ]to[- ]date|last (?:few days|week|month|year)|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|over the last (?:few days|week|month|year)|[135]\s*[- ]?year)\b/i.test(
    message
  );
}

/**
 * Web search is the slowest lane, so a comparison fans out into a bounded
 * number of consolidated queries instead of one per entity.
 */
const MAX_WEB_QUERIES = 3;
const MAX_DEEP_ENTITY_GROUPS = 2;

function consolidate<T>(items: T[], maxGroups: number): T[][] {
  if (items.length <= maxGroups) return items.map((item) => [item]);
  const size = Math.ceil(items.length / maxGroups);
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function groupId(prefix: string, entities: FinanceEntity[]): string {
  return `${prefix}-${entities
    .map((entity) => entity.id.replace(/[^a-z0-9]+/gi, "-"))
    .join("_")}`.slice(0, 120);
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
  /** Deep uses the same planner contract; regular behavior remains the default. */
  depth?: "regular" | "deep";
  message: string;
  entities: FinanceEntity[];
  state: ConversationState;
  asOf?: string;
  intervals?: TemporalInterval[];
  /** When false the plan is produced for telemetry but carries no queries. */
  retrievalAuthorized?: boolean;
}): EvidencePlan {
  const asOf = args.asOf ?? new Date().toISOString();
  const queries: EvidenceQuery[] = [];
  const intervals = args.intervals ?? args.state.intervals ?? [];
  const capabilities = args.entities.map((entity) => ({
    entity,
    capability: listingCapability(entity),
  }));
  // Provider selection reads instrument capability, not a `market === "us"` check.
  const us = capabilities
    .filter(({ capability }) => capability.quoteStrategy === "primary_us")
    .map(({ entity }) => entity);
  const web = args.entities.filter((entity) => entity.market === "web");
  const marketData = marketQuoteEligible(args.entities);
  const intervalNote = intervals
    .map((value) => describeInterval(value))
    .join("; ");
  const astraEligible = args.entities.filter((entity) => entity.ticker);
  const entityContext = args.entities.map((entity) => entity.query).join("; ");
  const fortuneRanking =
    /\bfortune\s*(?:100|500)\b/i.test(args.message) ||
    args.entities.some((entity) => /^Fortune (?:100|500)$/.test(entity.name));
  const moveCause = isMoveCauseAsk(args.message);
  const currentCriteria = fortuneRanking
    ? ["revenue ranking"]
    : moveCause
      ? ["current developments", "performance"]
    : /\b(?:earnings|revenue|profit|margin)\b/i.test(args.message)
      ? ["earnings"]
      : args.state.criteria.length > 0
        ? args.state.criteria
        : historicalPeriod(args.message)
          ? ["performance"]
          : ["current developments"];
  const deepCriteria = [
    ...new Set([
      ...currentCriteria,
      ...args.state.criteria,
      "risk",
      "earnings",
      "outlook",
    ]),
  ].slice(0, 8);
  const plannedCriteria =
    args.depth === "deep" ? deepCriteria : currentCriteria;
  const groundedQuery = [
    args.message,
    entityContext ? `Context: ${entityContext}` : "",
    `Focus: ${currentCriteria.join(", ")}`,
    intervalNote
      ? `Period: ${intervalNote}`
      : args.state.horizon
        ? `Period: ${args.state.horizon}`
        : "",
    fortuneRanking
      ? `Use the latest official Fortune ranking available as of ${new Date().getUTCFullYear()}. Prefer fortune.com or fortunemedia.mediaroom.com`
      : moveCause
        ? "Use reporting from the requested trading window. Do not present an older event as the cause of the current move"
      : currentCriteria.includes("earnings")
        ? "Prefer the company investor-relations release, SEC filing, exchange disclosure, or Reuters"
      : "",
  ]
    .filter(Boolean)
    .join(". ");
  const freshnessDays = fortuneRanking
    ? 550
    : moveCause
      ? 4
      : evidenceFreshnessDays(args.message);
  const historical = historicalPeriod(args.message);

  if (args.route === "current_finance") {
    if (us.length > 0 && (!historical || supportsTrailingQuote(args.message))) {
      queries.push(
        query("quotes-current", "quotes", args.message, us, ["price"], "news", 4)
      );
    }
    if (
      marketData.length > 0 &&
      (!historical || supportsTrailingQuote(args.message))
    ) {
      queries.push(
        query(
          "market-proxy-current",
          "market_proxy",
          args.message,
          marketData,
          ["price"],
          "news",
          6
        )
      );
    }
    if (astraEligible.length > 0) {
      queries.push(
        query(
          "astra-current",
          "astra",
          args.message,
          astraEligible,
          plannedCriteria,
          "news",
          isPriceOnly(args.message) ? 4 : 8,
          astraFreshnessDays(args.message, freshnessDays, moveCause)
        )
      );
    }
    if (
      args.depth === "deep" ||
      !isPriceOnly(args.message) ||
      historical ||
      web.length > 0 ||
      args.entities.length === 0
    ) {
      const targets = web.length > 0 ? web : args.entities;
      if (args.depth === "deep") {
        for (const group of consolidate(targets, MAX_DEEP_ENTITY_GROUPS)) {
          const names = group.map((entity) => entity.query).join(" OR ");
          queries.push(
            query(
              groupId("tavily-deep-risk", group),
              "tavily",
              `${names} material risks regulation litigation competition. Context: ${args.message.slice(0, 160)}`,
              group,
              ["risk"],
              "news",
              Math.min(8, 4 * group.length),
              180
            ),
            query(
              groupId("tavily-deep-outlook", group),
              "tavily",
              `${names} latest earnings investor relations guidance catalysts outlook. Context: ${args.message.slice(0, 160)}`,
              group,
              ["earnings", "outlook"],
              "general",
              Math.min(8, 4 * group.length),
              240
            )
          );
        }
      } else if (targets.length > 1) {
        for (const group of consolidate(targets, MAX_WEB_QUERIES)) {
          queries.push(
            query(
              groupId("tavily-current", group),
              "tavily",
              `${group.map((entity) => entity.query).join(" OR ")} ${currentCriteria.join(" ")}. Context: ${args.message.slice(0, 160)}`,
              group,
              currentCriteria,
              fortuneRanking ? "general" : "news",
              3 * group.length,
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
      args.depth === "deep"
        ? deepCriteria
        : args.state.criteria.length > 0
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
      args.entities.length <= 12
    ) {
      queries.push(
        query(
          "quotes-comparison",
          "quotes",
          args.message,
          us,
          criteria,
          "general",
          Math.min(12, us.length)
        )
      );
    }
    if (
      marketData.length > 0 &&
      (!historical || supportsTrailingQuote(args.message)) &&
      args.entities.length <= 12
    ) {
      queries.push(
        query(
          "market-proxy-comparison",
          "market_proxy",
          args.message,
          marketData,
          criteria,
          "general",
          Math.min(6, marketData.length)
        )
      );
    }
    if (astraEligible.length > 0) {
      queries.push(
        query(
          "astra-comparison",
          "astra",
          args.message,
          astraEligible,
          criteria,
          topic,
          Math.min(12, astraEligible.length * 3),
          astraFreshnessDays(
            args.message,
            topic === "news" ? freshnessDays : 60
          )
        )
      );
    }
    for (const group of consolidate(
      args.entities,
      args.depth === "deep" ? MAX_DEEP_ENTITY_GROUPS : MAX_WEB_QUERIES
    )) {
      const names = group.map((entity) => entity.query).join(" OR ");
      if (args.depth === "deep") {
        queries.push(
          query(
            groupId("tavily-deep-risk", group),
            "tavily",
            `${names} material risks regulation litigation competition. Context: ${args.message.slice(0, 160)}`,
            group,
            ["risk"],
            "news",
            Math.min(8, 4 * group.length),
            180
          ),
          query(
            groupId("tavily-deep-outlook", group),
            "tavily",
            `${names} latest earnings investor relations guidance catalysts outlook. Context: ${args.message.slice(0, 160)}`,
            group,
            ["earnings", "outlook"],
            "general",
            Math.min(8, 4 * group.length),
            240
          )
        );
      } else {
        queries.push(
          query(
            groupId("tavily", group),
            "tavily",
            `${names} ${criteria.join(" ")}. Context: ${args.message.slice(0, 160)}`,
            group,
            criteria,
            topic,
            3 * group.length,
            topic === "news" ? freshnessDays : undefined
          )
        );
      }
    }
  }

  if (args.retrievalAuthorized === false) {
    return {
      version: 1,
      depth: args.depth ?? "regular",
      route: args.route,
      asOf,
      queries: [],
      requiredEntityIds: [],
      criteria: [],
      explicitCriteria: currentCriteria,
      causal: moveCause,
      horizon: args.state.horizon,
      intervals,
    };
  }

  return {
    version: 1,
    depth: args.depth ?? "regular",
    route: args.route,
    asOf,
    queries,
    requiredEntityIds:
      args.depth === "deep" || args.route === "comparison"
        ? args.entities.map((entity) => entity.id)
        : [],
    criteria:
      args.depth === "deep"
        ? deepCriteria
        : args.route === "comparison"
        ? args.state.criteria.length > 0
          ? args.state.criteria
          : DEFAULT_COMPARISON_CRITERIA
        : [],
    explicitCriteria:
      args.depth === "deep"
        ? deepCriteria
        : args.route === "comparison"
          ? [...args.state.criteria]
          : currentCriteria,
    causal: moveCause,
    horizon: args.state.horizon,
    intervals,
  };
}

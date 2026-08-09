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

function historicalPeriod(intervals: readonly TemporalInterval[]): boolean {
  return intervals.some((interval) => interval.label !== "today");
}

function intervalAgeDays(
  intervals: readonly TemporalInterval[],
  asOf: string
): number {
  const current = Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`);
  const oldest = intervals.reduce(
    (value, interval) =>
      interval.startSession < value ? interval.startSession : value,
    asOf.slice(0, 10)
  );
  const target = Date.parse(`${oldest}T00:00:00.000Z`);
  return Number.isFinite(current) && Number.isFinite(target)
    ? Math.max(0, Math.ceil((current - target) / 86_400_000))
    : 0;
}

function evidenceFreshnessDays(
  intervals: readonly TemporalInterval[],
  asOf: string
): number {
  if (!historicalPeriod(intervals)) return 14;
  const age = intervalAgeDays(intervals, asOf);
  if (age <= 14) return 14;
  if (age <= 45) return 45;
  if (age <= 120) return 120;
  if (age <= 400) return 400;
  return Math.min(3650, age + 14);
}

// Astra stores ~90 days; use wider history except for explicit today/yesterday asks.
function astraFreshnessDays(
  intervals: readonly TemporalInterval[],
  _asOf: string,
  freshnessDays: number,
  moveCause = false
): number {
  if (moveCause) return freshnessDays ?? 4;
  return intervals.some(
    (interval) =>
      interval.label === "today" || interval.label === "yesterday"
  )
    ? Math.min(freshnessDays, 7)
    : Math.max(freshnessDays, 60);
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
        : historicalPeriod(intervals)
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
      : "",
    fortuneRanking
      ? `Use the latest official Fortune ranking available as of ${new Date(asOf).getUTCFullYear()}. Prefer fortune.com or fortunemedia.mediaroom.com`
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
      : evidenceFreshnessDays(intervals, asOf);
  const historical = historicalPeriod(intervals);

  if (args.route === "current_finance") {
    if (us.length > 0) {
      queries.push(
        query("quotes-current", "quotes", args.message, us, ["price"], "news", 4)
      );
    }
    if (
      marketData.length > 0
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
          astraFreshnessDays(intervals, asOf, freshnessDays, moveCause)
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
    const topic =
      historical ||
      /\b(?:current|recent|latest|earnings|regulat|legal)\b/i.test(args.message)
      ? "news"
      : "general";
    if (
      us.length > 0 && args.entities.length <= 12
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
      marketData.length > 0 && args.entities.length <= 12
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
            intervals,
            asOf,
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

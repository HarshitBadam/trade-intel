import type { EvidenceInput } from "../citations";
import { retrieveAstra } from "../evidence/astra";
import {
  searchTavily,
  searchTavilyDetailed,
} from "../tavily";
import type {
  ChatRequest,
  EvidenceQuery,
  FinanceEntity,
} from "../types";
import type {
  FocusedNewsBundle,
  FocusedNewsOutcome,
} from "./contracts";

function newsQueries(
  request: ChatRequest,
  entities: readonly FinanceEntity[],
  dates: readonly string[]
): [EvidenceQuery, EvidenceQuery] {
  const tickers = [
    ...new Set(
      entities.flatMap((entity) => (entity.ticker ? [entity.ticker] : []))
    ),
  ];
  const entityIds = [...new Set(entities.map((entity) => entity.id))];
  const period =
    dates.length > 0
      ? `${[...dates].sort()[0]} to ${[...dates].sort().at(-1)}`
      : "current";
  const query = `${entities.map((entity) => entity.name).join(" vs ")} ${request.message} relevant financial news and market drivers ${period}`.slice(
    0,
    500
  );
  const base = {
    query,
    entityIds,
    tickers,
    criteria: ["market drivers", "material developments"],
    topic: "news" as const,
    limit: 6,
  };
  return [
    { ...base, id: "simple-astra", provider: "astra" },
    { ...base, id: "simple-tavily", provider: "tavily" },
  ];
}

export async function retrieveNews(
  request: ChatRequest,
  entities: readonly FinanceEntity[],
  dates: readonly string[]
): Promise<EvidenceInput[]> {
  if (entities.length === 0) return [];
  const [astraQuery, tavilyQuery] = newsQueries(request, entities, dates);
  const [astra, tavily] = await Promise.allSettled([
    retrieveAstra(astraQuery, [...entities]),
    searchTavily(tavilyQuery),
  ]);
  return [
    ...(astra.status === "fulfilled" ? astra.value : []),
    ...(tavily.status === "fulfilled" ? tavily.value : []),
  ];
}

export async function retrieveFocusedNews(
  queries: readonly string[],
  entities: readonly FinanceEntity[]
): Promise<FocusedNewsBundle> {
  if (queries.length === 0) return { evidence: [], outcomes: [] };
  const entityIds = [...new Set(entities.map((entity) => entity.id))];
  const tickers = [
    ...new Set(
      entities.flatMap((entity) => (entity.ticker ? [entity.ticker] : []))
    ),
  ];
  const entityContext = entities
    .map((entity) =>
      entity.ticker ? `${entity.name} (${entity.ticker})` : entity.name
    )
    .join(" ");
  const results = await Promise.all(
    queries.map(async (query, index) => {
      const searchQuery =
        `${query}${entityContext ? ` ${entityContext}` : ""}`.slice(0, 500);
      const request: EvidenceQuery = {
        id: `simple-focused-news-${index + 1}`,
        provider: "tavily",
        query: searchQuery,
        entityIds,
        tickers,
        criteria: ["specific requested story"],
        topic: "news",
        limit: 6,
      };
      const result = await searchTavilyDetailed(request);
      return {
        result,
        outcome: {
          query,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          evidenceCount: result.evidence.length,
        } satisfies FocusedNewsOutcome,
      };
    })
  );
  return {
    evidence: results.flatMap(({ result }) => result.evidence),
    outcomes: results.map(({ outcome }) => outcome),
  };
}

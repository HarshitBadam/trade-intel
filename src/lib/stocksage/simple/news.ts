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

const FOCUSED_QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "allegation",
  "allegations",
  "alleged",
  "controversy",
  "event",
  "incident",
  "latest",
  "news",
  "report",
  "reporting",
  "reports",
  "story",
  "that",
  "their",
  "they",
  "time",
  "what",
  "when",
  "with",
]);

function searchTokens(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .match(/\p{Letter}[\p{Letter}\p{Number}]*/gu) ?? []
  );
}

export function filterFocusedNewsEvidence(
  query: string,
  entities: readonly FinanceEntity[],
  evidence: readonly EvidenceInput[]
): EvidenceInput[] {
  const entityTokens = new Set(
    entities.flatMap((entity) =>
      searchTokens(`${entity.name} ${entity.ticker ?? ""}`)
    )
  );
  const topicTokens = [
    ...new Set(
      searchTokens(query).filter(
        (token) =>
          token.length >= 3 &&
          !entityTokens.has(token) &&
          !FOCUSED_QUERY_STOP_WORDS.has(token)
      )
    ),
  ];
  if (topicTokens.length === 0) return [...evidence];
  const requiredMatches = topicTokens.length >= 3 ? 2 : 1;
  return evidence.filter((item) => {
    if ((item.score ?? 0) >= 0.5) return true;
    const text = searchTokens(`${item.title} ${item.excerpt}`).join("");
    const matches = topicTokens.filter((token) => text.includes(token)).length;
    return matches >= requiredMatches;
  });
}

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
      const evidence = filterFocusedNewsEvidence(
        query,
        entities,
        result.evidence
      );
      const status =
        result.status === "ok" && evidence.length === 0
          ? "no_results"
          : result.status;
      return {
        result: { ...result, status, evidence },
        outcome: {
          query,
          status,
          ...(result.reason ? { reason: result.reason } : {}),
          evidenceCount: evidence.length,
        } satisfies FocusedNewsOutcome,
      };
    })
  );
  return {
    evidence: results.flatMap(({ result }) => result.evidence),
    outcomes: results.map(({ outcome }) => outcome),
  };
}

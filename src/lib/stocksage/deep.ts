import "server-only";

import { hasDeepResearch } from "@/lib/config";
import {
  expandValidCitations,
  stripTickerCitationMarkers,
  validCitationUrls,
} from "./citations";
import {
  parseDeepResearchSnapshot,
  type DeepResearchSnapshot,
} from "./deep-snapshot";
import { unsupportedFigures } from "./figures";
import { runIdempotentDeepWork } from "./deep-store";
import { validateDeepResearchResult } from "./deep-validation";
import { planEvidence } from "./planning";
import { STOCKSAGE_DEEP_SYSTEM } from "./prompt";
import { executeEvidencePlan } from "./retrieve";
import { synthesizeWithFallback } from "./synthesis";
import type {
  ConversationState,
  DeepResearchReply,
  EvidenceSource,
  FinanceEntity,
} from "./types";

function percent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "not available";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function quoteBlock(context: Awaited<ReturnType<typeof executeEvidencePlan>>): string {
  if (context.quotes.length === 0) return "No validated quote is available.";
  return context.quotes
    .map(
      (quote) =>
        `${quote.ticker}: as of ${quote.asOf}, $${quote.price.toFixed(2)}, day ${percent(quote.dayPct)}, 1W ${percent(quote.weekPct)}, 1M ${percent(quote.monthPct)}, 1Y ${percent(quote.yearPct)}`
    )
    .join("\n");
}

function sourceBlock(sources: EvidenceSource[]): string {
  return sources
    .map(
      (source) =>
        `[${source.id}] ${source.outlet} | ${source.publishedAt ?? "date not supplied"} | ${source.title}\nExcerpt: ${source.excerpt}`
          .slice(0, 520)
    )
    .join("\n\n");
}

function snapshotContext(snapshot: DeepResearchSnapshot): {
  entities: FinanceEntity[];
  state: ConversationState;
} {
  const entities = snapshot.entities.map((entity) => ({
    ...entity,
    query: entity.ticker ?? entity.name,
    jurisdiction: snapshot.jurisdiction,
  }));
  return {
    entities,
    state: {
      version: 1,
      revision: snapshot.stateRevision,
      entities,
      explicitEntitySet: entities.map((entity) => entity.id),
      criteria: snapshot.criteria,
      horizon: snapshot.horizon,
      jurisdiction: snapshot.jurisdiction,
    },
  };
}

async function executeDeepResearch(
  snapshot: DeepResearchSnapshot
): Promise<DeepResearchReply> {
  if (!hasDeepResearch) {
    return {
      workId: snapshot.workId,
      status: "failure",
      text: "Research deeper isn’t configured right now.",
    };
  }

  let stage = "setup";
  try {
    const { entities, state } = snapshotContext(snapshot);
    const route = entities.length > 1 ? "comparison" : "current_finance";
    const retrievalMessage = `${snapshot.question}\nResearch context: catalysts, outlook, and material risks.`;
    const plan = planEvidence({
      route,
      message: retrievalMessage,
      entities,
      state,
    });
    if (entities.length === 1) {
      const entity = entities[0];
      const tickers = entity.ticker ? [entity.ticker] : [];
      plan.queries.push(
        {
          id: "tavily-deep-risks",
          provider: "tavily",
          query: `${entity.query} latest investor risks regulation litigation competition`,
          entityIds: [entity.id],
          tickers,
          criteria: ["risk"],
          freshnessDays: 120,
          topic: "news",
          limit: 4,
        },
        {
          id: "tavily-deep-fundamentals",
          provider: "tavily",
          query: `${entity.query} latest earnings investor relations guidance outlook`,
          entityIds: [entity.id],
          tickers,
          criteria: ["earnings", "outlook"],
          freshnessDays: 180,
          topic: "general",
          limit: 4,
        }
      );
    }
    stage = "retrieval";
    const context = await executeEvidencePlan({ plan, entities });
    if (context.sources.length === 0) {
      return {
        workId: snapshot.workId,
        status: "failure",
        text: "I couldn’t retrieve enough verifiable evidence for deeper research. The regular answer is still available.",
        retryable: true,
      };
    }
    const user = `ORIGINAL QUESTION
${snapshot.question}

REGULAR ANSWER
${snapshot.regularAnswer}

AS OF
${plan.asOf}

VALIDATED QUOTES
${quoteBlock(context)}

RETRIEVED SOURCES
${sourceBlock(context.sources)}

ENTITIES
${entities.map((entity) => entity.ticker ?? entity.name).join(", ") || "none"}

CRITERIA
${snapshot.criteria.join(", ") || "not specified"}

HORIZON
${snapshot.horizon ?? "not specified"}`;
    stage = "synthesis";
    const text = await synthesizeWithFallback({
      system: `${STOCKSAGE_DEEP_SYSTEM}

Use only citation IDs from RETRIEVED SOURCES, such as [S1]. Never write a raw URL or invent an ID. The server will turn valid IDs into links.`,
      user,
      maxTokens: 1100,
      temperature: 0.35,
      timeoutMs: 25_000,
      totalTimeoutMs: 32_000,
      event: "deep_synthesis",
      accept: (candidate) =>
        validCitationUrls(candidate, context.sources).length > 0 &&
        unsupportedFigures(candidate, user).length === 0,
      correction: (draft) => {
        const invented = unsupportedFigures(draft, user);
        return `Rewrite that answer. ${
          invented.length > 0
            ? `These figures are not in the quotes or sources you were given, so remove them without substituting other numbers from memory: ${invented.join(", ")}. `
            : ""
        }Every claim taken from RETRIEVED SOURCES must end with its ID like [S1]. Keep the same structure and depth.`;
      },
    });
    stage = "citation_validation";
    const cleaned = stripTickerCitationMarkers(
      text,
      context.quotes.map((quote) => quote.ticker)
    );
    const citationUrls = validCitationUrls(cleaned, context.sources);
    const expanded = expandValidCitations(cleaned, context.sources);
    const validationError = validateDeepResearchResult({
      snapshot,
      text: expanded,
      citationUrls,
    });
    if (validationError) {
      return {
        workId: snapshot.workId,
        status: "failure",
        text: validationError,
        retryable: true,
      };
    }
    return {
      workId: snapshot.workId,
      status: "success",
      text: expanded,
      citationUrls,
    };
  } catch (error) {
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "deep_failure",
        provider: "direct-research",
        stage,
        reason: error instanceof Error ? error.name : "unknown",
        detail:
          error instanceof Error
            ? error.message.slice(0, 300)
            : String(error).slice(0, 300),
      })}`
    );
    if (error instanceof Error && error.stack) {
      console.error(
        `[stocksage] deep_failure stack: ${error.stack.split("\n").slice(0, 6).join(" | ")}`
      );
    }
    return {
      workId: snapshot.workId,
      status: "failure",
      text: "Research deeper couldn’t complete this request. The regular answer remains available.",
      retryable: true,
    };
  }
}

export async function runDeepResearch(
  token: unknown
): Promise<DeepResearchReply> {
  const snapshot = parseDeepResearchSnapshot(token);
  if (!snapshot) {
    return {
      workId: "invalid",
      status: "failure",
      text: "This research request is invalid or expired.",
    };
  }
  return runIdempotentDeepWork(snapshot.workId, () =>
    executeDeepResearch(snapshot)
  );
}

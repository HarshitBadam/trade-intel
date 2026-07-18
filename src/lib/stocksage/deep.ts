import "server-only";

import {
  hasDeepResearch,
  hasLangflow,
  LANGFLOW_FLOW_ID,
} from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import { runLangflowFlow } from "@/lib/langflow";
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
import {
  firstPersonVerificationLimitation,
  hasSmuggledOffTopicTask,
  hedgedEstimateClaim,
  investmentDirectionClaim,
  performsSmuggledTask,
  proxyMisrepresentation,
  uncitedResearchClaimUnits,
} from "./regular-guards";
import { roundFiguresForDisplay } from "./rounding";
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
        `${quote.proxySymbol ? `${quote.proxySymbol} (${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy for requested ${quote.ticker})` : quote.ticker}: as of ${quote.asOf}${quote.eod ? " close (end-of-day)" : ""}, ${
          quote.isIndex
            ? `${quote.price.toFixed(2)} points`
            : `$${quote.price.toFixed(2)}`
        }${quote.sourceNote ? ` (${quote.sourceNote})` : ""}, day ${percent(quote.dayPct)}, 1W ${percent(quote.weekPct)}, 1M ${percent(quote.monthPct)}, 1Y ${percent(quote.yearPct)}${
          quote.proxySymbol
            ? `. Start every quote line with ${quote.proxySymbol}. Attribute every figure to ${quote.proxySymbol}, never to ${quote.ticker} or the underlying index/listing${
                quote.proxyKind === "adr"
                  ? '; say "not the underlying Australian listing return"'
                  : ""
              }`
            : ""
        }`
    )
    .join("\n");
}

function subjectName(entities: FinanceEntity[]): string {
  if (entities.length === 0) return "this topic";
  if (entities.length === 1) return entities[0].name;
  return `${entities
    .slice(0, -1)
    .map((entity) => entity.name)
    .join(", ")} and ${entities.at(-1)?.name}`;
}

function unavailableResearchCopy(entities: FinanceEntity[]): string {
  return `There isn’t enough current reporting on ${subjectName(
    entities
  )} for a deeper report right now — the answer above stands; try again shortly.`;
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

// Deep research is the one surface where the hosted Langflow flow fits:
// low-volume, opt-in, latency-tolerant, and idempotent, with the direct
// multi-provider path as fallback. Output must pass the same acceptance
// checks as direct synthesis or it is discarded.
async function langflowDeepSynthesis(args: {
  system: string;
  user: string;
  accept: (text: string) => boolean;
}): Promise<string | null> {
  if (!hasLangflow || !LANGFLOW_FLOW_ID) return null;
  if (await isOpen("langflow-deep")) return null;
  try {
    const text = await runLangflowFlow({
      flowId: LANGFLOW_FLOW_ID,
      input: `${args.system}\n\n${args.user}`,
      timeoutMs: 25_000,
    });
    const trimmed = text.trim();
    if (!trimmed || !args.accept(trimmed)) {
      console.error(
        `[stocksage] ${JSON.stringify({
          event: "deep_synthesis",
          provider: "langflow-deep",
          name: "SynthesisValidationError",
        })}`
      );
      return null;
    }
    await recordSuccess("langflow-deep");
    console.info(
      `[stocksage] ${JSON.stringify({
        event: "deep_synthesis",
        provider: "langflow-deep",
        status: "success",
      })}`
    );
    return trimmed;
  } catch (error) {
    await recordFailure("langflow-deep");
    console.error(
      `[stocksage] ${JSON.stringify({
        event: "deep_synthesis",
        provider: "langflow-deep",
        name: error instanceof Error ? error.name : "unknown",
        detail:
          error instanceof Error
            ? error.message.slice(0, 200)
            : String(error).slice(0, 200),
      })}`
    );
    return null;
  }
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
        text: unavailableResearchCopy(entities),
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
    const today = new Date().toISOString().slice(0, 10);
    const system = `${STOCKSAGE_DEEP_SYSTEM}

Today is ${today}. Treat that as the date anchor. Use "upcoming", "next-gen", "new", "recent", or "latest" only when a retrieved source explicitly dates the claim relative to today.
Use only citation IDs from RETRIEVED SOURCES, such as [S1]. Never write a raw URL or invent an ID. The server will turn valid IDs into links.`;
    // The same no-leakage bar as regular synthesis: when the original
    // question smuggled an off-topic task alongside the finance ask, deep
    // output must not perform it either (leaks propagate through the
    // REGULAR ANSWER block otherwise).
    const smuggled = hasSmuggledOffTopicTask(snapshot.question);
    const accept = (candidate: string) =>
      validCitationUrls(candidate, context.sources).length > 0 &&
      uncitedResearchClaimUnits(candidate, context.sources).length === 0 &&
      investmentDirectionClaim(candidate) === null &&
      firstPersonVerificationLimitation(candidate) === null &&
      unsupportedFigures(candidate, user).length === 0 &&
      hedgedEstimateClaim(candidate, user) === null &&
      proxyMisrepresentation(candidate, entities, context.quotes) === null &&
      !(smuggled && performsSmuggledTask(candidate));
    const langflowText = await langflowDeepSynthesis({ system, user, accept });
    const text =
      langflowText ??
      (await synthesizeWithFallback({
        system,
        user,
        maxTokens: 1100,
        temperature: 0.35,
        timeoutMs: 25_000,
        totalTimeoutMs: 32_000,
        event: "deep_synthesis",
        accept,
        correction: (draft) => {
          const invented = unsupportedFigures(draft, user);
          const hedged = hedgedEstimateClaim(draft, user);
          const proxyError = proxyMisrepresentation(
            draft,
            entities,
            context.quotes
          );
          const uncitedClaims = uncitedResearchClaimUnits(
            draft,
            context.sources
          );
          const direction = investmentDirectionClaim(draft);
          const limitation = firstPersonVerificationLimitation(draft);
          return `Rewrite that answer. ${
            invented.length > 0
              ? `These figures are not in the quotes or sources you were given, so remove them without substituting other numbers from memory: ${invented.join(", ")}. `
              : ""
          }${
            hedged
              ? `Remove this unsupported hedged performance estimate without replacing it from memory: "${hedged}". `
              : ""
          }${
            proxyError
              ? `Correct this proxy-data misrepresentation: "${proxyError}". Name the ETF/ADR and attribute all proxy figures to it, not the underlying index or local listing. `
              : ""
          }${
            uncitedClaims.length > 0
              ? `These research sentences or bullets need a valid [S#] in the same unit or must be removed: ${uncitedClaims
                  .map((unit) => `"${unit}"`)
                  .join(" | ")}. A citation elsewhere does not support them. `
              : ""
          }${
            direction
              ? `Remove this investment-direction wording and describe the evidence neutrally: "${direction}". `
              : ""
          }${
            limitation
              ? `Replace this first-person verification limitation with neutral gap wording: "${limitation}". `
              : ""
          }${
            smuggled && performsSmuggledTask(draft)
              ? "The original question included an off-topic task (a calculation, code, or similar); research the finance part only and never compute, solve, or restate the off-topic result. "
              : ""
          }Every claim taken from RETRIEVED SOURCES must end with its ID like [S1]. Keep the same structure and depth.`;
        },
      }));
    stage = "citation_validation";
    const cleaned = stripTickerCitationMarkers(
      text,
      context.quotes.map((quote) => quote.ticker)
    );
    const citationUrls = validCitationUrls(cleaned, context.sources);
    const expanded = roundFiguresForDisplay(
      expandValidCitations(cleaned, context.sources)
    );
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
      text: unavailableResearchCopy(snapshotContext(snapshot).entities),
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

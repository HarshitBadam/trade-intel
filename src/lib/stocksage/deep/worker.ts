import "server-only";

import { hasDeepResearch } from "@/lib/config";
import {
  type DeepResearchSnapshot,
} from "./snapshot";
import { unsupportedFigures } from "../figures";
import {
  firstPersonVerificationLimitation,
  hasSmuggledOffTopicTask,
  hedgedEstimateClaim,
  investmentDirectionClaim,
  performsSmuggledTask,
  proxyMisrepresentation,
  uncitedResearchClaimUnits,
} from "../regular-guards";
import {
  deepSynthesisChecks,
  evaluatePublicationCandidate,
  finalizePublicationText,
} from "../publication";
import { validateDeepResearchResult } from "./validation";
import { planEvidence } from "../evidence/planner";
import { STOCKSAGE_DEEP_SYSTEM } from "../prompt";
import { executeEvidencePlan } from "../evidence/retrieve";
import { synthesizeWithFallback } from "../synthesis";
import type {
  ConversationState,
  DeepResearchReply,
  EvidenceSource,
  FinanceEntity,
} from "../types";

function percent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function quoteBlock(context: Awaited<ReturnType<typeof executeEvidencePlan>>): string {
  if (context.quotes.length === 0) {
    return "Use source evidence only; do not discuss quote coverage.";
  }
  return context.quotes
    .map(
      (quote) =>
        `${quote.proxySymbol ? `${quote.proxySymbol} (${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy for requested ${quote.ticker})` : quote.venue === "ASX" ? `ASX:${quote.ticker} (native ${quote.instrumentSymbol ?? `${quote.ticker}.AX`} listing, AUD)` : quote.ticker}: as of ${quote.asOf}${quote.eod ? " close (end-of-day)" : ""}, ${
          quote.isIndex
            ? `${quote.price.toFixed(2)} points`
            : `${quote.currency === "AUD" ? "A$" : "$"}${quote.price.toFixed(2)}`
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
  return `The answer above remains the supported view on ${subjectName(
    entities
  )}. Run Research deeper again from that answer for a new evidence pass.`;
}

function sourceBlock(sources: EvidenceSource[]): string {
  return sources
    .map(
      (source) =>
        `[${source.id}] ${source.outlet}${source.publishedAt ? ` | ${source.publishedAt}` : ""} | ${source.title}\nExcerpt: ${source.excerpt}`
          .slice(0, 520)
    )
    .join("\n\n");
}

function deterministicDeepReport(
  entities: FinanceEntity[],
  sources: EvidenceSource[],
  asOf: string
): string {
  const evidence = sources
    .slice(0, 8)
    .map((source) => {
      const compact = source.excerpt.replace(/\s+/g, " ").trim();
      const directional = investmentDirectionClaim(compact);
      const neutral = directional
        ? compact.replace(directional, "").replace(/\s+/g, " ").trim()
        : compact;
      const detail =
        neutral.length > 260
          ? `${neutral.slice(0, 257).replace(/\s+\S*$/, "").trimEnd()}…`
          : neutral;
      return `- **${source.title}** — ${source.outlet}${
        source.publishedAt ? `, ${source.publishedAt}` : ""
      }: ${detail} [${source.id}]`;
    })
    .join("\n");
  return `### Deeper evidence review

This report covers ${subjectName(entities)} using the validated reporting available as of ${asOf.slice(0, 10)}.

${evidence}

### What to watch

Use the source-specific developments above as the evidence set; every conclusion stays tied to those citations.`;
}

function snapshotContext(snapshot: DeepResearchSnapshot): {
  entities: FinanceEntity[];
  state: ConversationState;
} {
  const entities: FinanceEntity[] =
    snapshot.version === 2
      ? snapshot.entities.map((entity) => ({ ...entity }))
      : snapshot.entities.map((entity) => ({
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
      groups: snapshot.version === 2 ? snapshot.groups : [],
      intervals: snapshot.version === 2 ? snapshot.intervals : undefined,
    },
  };
}

export async function executeDeepResearch(
  snapshot: DeepResearchSnapshot
): Promise<DeepResearchReply> {
  if (!hasDeepResearch) {
    return {
      workId: snapshot.workId,
      status: "failure",
      text: "The answer above remains the supported view for this request.",
    };
  }

  let stage = "setup";
  try {
    const { entities, state } = snapshotContext(snapshot);
    const route =
      snapshot.version === 2
        ? snapshot.route
        : entities.length > 1
          ? "comparison"
          : "current_finance";
    const plan = planEvidence({
      route,
      depth: "deep",
      message: snapshot.question,
      entities,
      state,
      asOf: snapshot.asOf,
      intervals:
        snapshot.version === 2
          ? snapshot.intervals
          : state.intervals,
    });
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
    const smuggled = hasSmuggledOffTopicTask(snapshot.question);
    const accept = (candidate: string) =>
      evaluatePublicationCandidate(candidate, deepSynthesisChecks({ smuggled }), {
        corpus: user,
        entities,
        quotes: context.quotes,
        sources: context.sources,
        requestedCriteria: [],
        hasSources: true,
      }) === null;
    let text: string;
    try {
      text = await synthesizeWithFallback({
        system,
        user,
        maxTokens: 1100,
        temperature: 0.35,
        timeoutMs: 5_000,
        totalTimeoutMs: 8_000,
        maxCandidates: 1,
        modelAttempts: "primary_only",
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
              ? `Remove this limitation or system-status sentence: "${limitation}". Answer the supported portion directly without replacing it with another disclaimer. `
              : ""
          }${
            smuggled && performsSmuggledTask(draft)
              ? "The original question included an off-topic task (a calculation, code, or similar); research the finance part only and never compute, solve, or restate the off-topic result. "
              : ""
          }Every claim taken from RETRIEVED SOURCES must end with its ID like [S1]. Keep the same structure and depth.`;
        },
      });
    } catch {
      // Provider and publication-check failures converge on the same
      // deterministic evidence report.
      text = deterministicDeepReport(entities, context.sources, plan.asOf);
    }
    stage = "citation_validation";
    let finalized = finalizePublicationText(text, context.sources, {
      stripTickers: true,
      tickers: context.quotes.map((quote) => quote.ticker),
    });
    let citationUrls = finalized.citationUrls;
    let expanded = finalized.text;
    let validationError = validateDeepResearchResult({
      snapshot,
      text: expanded,
      citationUrls,
    });
    if (validationError) {
      finalized = finalizePublicationText(
        deterministicDeepReport(entities, context.sources, plan.asOf),
        context.sources
      );
      citationUrls = finalized.citationUrls;
      expanded = finalized.text;
      validationError = validateDeepResearchResult({
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

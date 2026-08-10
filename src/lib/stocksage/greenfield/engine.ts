import "server-only";

import { randomUUID } from "node:crypto";
import {
  getBarsForRange,
  type RangeBarDependencies,
  type RangeBarSeries,
} from "@/lib/market-data/range-bars";
import {
  getSecCompanyFacts,
  type SecCompanyFact,
  type SecEdgarDependencies,
} from "@/lib/market-data/sec-edgar";
import {
  resolveSecurity,
  type SecurityMasterOptions,
  type SecurityMasterRecord,
} from "@/lib/market-data/security-master";
import {
  createProductionHybridDocumentPorts,
  retrieveDocumentsHybrid,
  type EvidenceItem,
  type HybridDocumentPorts,
  type HybridRetrievalResult,
} from "./documents";
import { detectCrisis, detectViolenceThreat, crisisResponse, VIOLENCE_THREAT_RESPONSE } from "../crisis";
import type { FinanceEntity } from "../types";
import type { MarketCalendar, TemporalInterval } from "../temporal";
import {
  answerAdaptively,
  type AdaptiveAnswer,
  type AtomicNumericTask,
  type ComposerDraft,
  type InjectedComposer,
} from "./answering";
import { defaultStructuredComposer } from "./composer";
import { conceptEvidence, findFinanceConcept } from "./concepts";
import {
  appendConversationTurn,
  createConversationLedger,
  latestLedgerState,
  ledgerInterpreterContext,
  type ConversationLedger,
} from "./conversation-ledger";
import {
  compileTemporalSpecs,
  createSemanticInterpreter,
  rewriteContextualQuery,
  type SemanticInterpretation,
  type SemanticJsonModel,
} from "./semantic-interpreter";
import {
  planGreenfieldTurn,
  type CompanyFactsNeed,
  type DocumentNeed,
  type GreenfieldExecutionPlan,
  type MarketDataNeed,
  type SecurityMasterNeed,
} from "./planner";
import {
  createResearchPlan,
  runResearchPlan,
  type ResearchEvidence,
  type ResearchPersistence,
  type ResearchProgressEvent,
  type ResearchRunRecord,
} from "./research";
import { defaultResearchPersistence } from "./persistence";

export type GreenfieldRequest = {
  message: string;
  sessionId?: string;
  ledger?: ConversationLedger;
  now?: Date;
};

export type GreenfieldTrace = {
  turnId: string;
  interpretation?: SemanticInterpretation;
  plan?: GreenfieldExecutionPlan;
  evidence: readonly ResearchEvidence[];
  documentDiagnostics?: HybridRetrievalResult["diagnostics"];
  researchRun?: ResearchRunRecord;
  failures: readonly { needId: string; error: string }[];
};

export type GreenfieldReply = {
  kind:
    | "answer"
    | "clarification"
    | "safety_support"
    | "refused"
    | "unavailable";
  text: string;
  ledger: ConversationLedger;
  answer?: AdaptiveAnswer;
  trace: GreenfieldTrace;
};

export type GreenfieldDependencies = {
  semanticModel?: SemanticJsonModel;
  composer?: InjectedComposer;
  market?: (
    need: MarketDataNeed,
    dependencies?: RangeBarDependencies
  ) => Promise<RangeBarSeries>;
  marketDependencies?: RangeBarDependencies;
  security?: (
    need: SecurityMasterNeed,
    options?: SecurityMasterOptions
  ) => Promise<SecurityMasterRecord | null>;
  securityOptions?: SecurityMasterOptions;
  companyFacts?: (
    need: CompanyFactsNeed,
    dependencies?: SecEdgarDependencies
  ) => Promise<SecCompanyFact[]>;
  secDependencies?: SecEdgarDependencies;
  documents?: HybridDocumentPorts;
  researchPersistence?: ResearchPersistence;
  researchSignal?: AbortSignal;
  onResearchProgress?: (
    event: ResearchProgressEvent
  ) => void | Promise<void>;
};

type ExecutionArtifacts = {
  evidence: ResearchEvidence[];
  documentDiagnostics?: HybridRetrievalResult["diagnostics"];
  researchRun?: ResearchRunRecord;
  failures: { needId: string; error: string }[];
};

function calendarFor(entities: readonly FinanceEntity[]): MarketCalendar {
  const publicEntities = entities.filter((entity) => !entity.private);
  return publicEntities.length > 0 &&
    publicEntities.every((entity) => entity.market === "au")
    ? "AU"
    : "US";
}

function venueFor(entity: FinanceEntity): "US" | "ASX" | "INDEX" | "UNKNOWN" {
  if (entity.market === "au") return "ASX";
  if (entity.market === "index") return "INDEX";
  if (entity.market === "us") return "US";
  return "UNKNOWN";
}

function currencyFor(entity: FinanceEntity): string | undefined {
  if (entity.market === "au") return "AUD";
  if (entity.market === "us") return "USD";
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function marketEvidence(
  need: MarketDataNeed,
  series: RangeBarSeries,
  retrievedAt: string
): ResearchEvidence | null {
  const within = series.bars.filter(
    (bar) =>
      bar.session >= need.interval.startSession &&
      bar.session <= need.interval.endSession
  );
  const baseline = series.bars
    .filter((bar) => bar.session < need.interval.startSession)
    .at(-1);
  const first = within.at(0);
  const last = within.at(-1);
  if (!first || !last) return null;
  const currency = currencyFor(need.entity);
  const returnPct =
    baseline && baseline.close !== 0
      ? ((last.close - baseline.close) / Math.abs(baseline.close)) * 100
      : null;
  const common = {
    instrument: series.instrumentSymbol,
    currency,
    periodStart: need.interval.startSession,
    periodEnd: need.interval.endSession,
    availableAt: last.timestamp,
  };
  return {
    id: `market:${need.entity.id}:${need.interval.startSession}:${need.interval.endSession}`,
    sourceId: series.provenance?.provider ?? "market_data",
    sourceUrl: series.provenance?.sourceUrl
      ? `${series.provenance.sourceUrl}#session=${need.interval.endSession}`
      : undefined,
    title: `${need.entity.name} ${need.interval.label}`,
    excerpt: `${series.instrumentSymbol} closed at ${last.close}${
      returnPct === null ? "" : ` with a ${returnPct}% return`
    } for the requested interval.`,
    retrievedAt,
    observedAt: last.timestamp,
    availableAt: last.timestamp,
    instrument: series.instrumentSymbol,
    currency,
    periodStart: need.interval.startSession,
    periodEnd: need.interval.endSession,
    quality: series.status === "complete" ? 1 : 0.7,
    supports: ["market-close", ...(returnPct === null ? [] : ["market-return"])],
    facts: {
      close: { value: last.close, ...common },
      firstClose: { value: first.close, ...common },
      ...(baseline
        ? {
            baselineClose: {
              value: baseline.close,
              instrument: series.instrumentSymbol,
              currency,
              periodStart: baseline.session,
              periodEnd: baseline.session,
              availableAt: baseline.timestamp,
            },
          }
        : {}),
      ...(returnPct === null
        ? {}
        : {
            returnPct: {
              value: returnPct,
              unit: "%",
              ...common,
            },
          }),
    },
  };
}

function securityEvidence(
  need: SecurityMasterNeed,
  security: SecurityMasterRecord,
  retrievedAt: string
): ResearchEvidence {
  const provenance = security.provenance[0];
  return {
    id: `security:${need.entity.id}`,
    sourceId: provenance?.provider ?? "security_master",
    sourceUrl: provenance?.sourceUrl,
    title: `${security.name} security identity`,
    excerpt: `${security.instrument.symbol} is a ${security.instrument.kind} instrument on ${security.instrument.venue} in ${security.instrument.currency}.`,
    retrievedAt,
    availableAt: provenance?.fetchedAt ?? retrievedAt,
    instrument: security.instrument.symbol,
    currency:
      security.instrument.currency === "NONE"
        ? undefined
        : security.instrument.currency,
    quality: 1,
    supports: ["issuer-instrument-identity", "listing-status"],
    facts: {
      legalName: { value: security.issuer.legalName },
      symbol: { value: security.instrument.symbol },
      venue: { value: security.instrument.venue },
      instrumentKind: { value: security.instrument.kind },
      currency: { value: security.instrument.currency },
      primaryListing: { value: security.instrument.primaryListing },
    },
  };
}

function privateCompanyEvidence(
  need: SecurityMasterNeed,
  retrievedAt: string
): ResearchEvidence {
  return {
    id: `security:${need.entity.id}`,
    sourceId: "stocksage_entity_catalog",
    title: `${need.entity.name} ownership status`,
    excerpt: `${need.entity.name} is privately held and has no public exchange listing.`,
    retrievedAt,
    availableAt: retrievedAt,
    quality: 1,
    supports: ["private-company-status", "listing-status"],
    facts: {
      private: { value: true },
      legalName: { value: need.entity.name },
    },
  };
}

function companyFactEvidence(
  need: CompanyFactsNeed,
  fact: SecCompanyFact,
  retrievedAt: string
): ResearchEvidence {
  return {
    id: `fact:${need.entity.id}:${fact.id}`,
    sourceId: "sec_edgar",
    sourceUrl: fact.provenance.sourceUrl,
    title: `${fact.entityName}: ${fact.label}`,
    excerpt: `${fact.label}: ${fact.value} ${fact.unit}, period ending ${fact.periodEnd}, filed ${fact.filedAt}.`,
    retrievedAt,
    observedAt: fact.periodEnd,
    availableAt: `${fact.filedAt}T23:59:59.999Z`,
    instrument: need.entity.ticker,
    currency: fact.unit.length === 3 ? fact.unit : undefined,
    periodStart: fact.periodStart ?? fact.periodEnd,
    periodEnd: fact.periodEnd,
    quality: 1,
    supports: [`sec-fact:${fact.concept}`],
    facts: {
      value: {
        value: fact.value,
        unit: fact.unit,
        currency: fact.unit.length === 3 ? fact.unit : undefined,
        instrument: need.entity.ticker,
        periodStart: fact.periodStart ?? fact.periodEnd,
        periodEnd: fact.periodEnd,
        availableAt: `${fact.filedAt}T23:59:59.999Z`,
      },
    },
  };
}

function documentEvidence(item: EvidenceItem): ResearchEvidence {
  return {
    id: item.evidenceId,
    sourceId: item.provenance.sourceId,
    sourceUrl: item.provenance.sourceUrl,
    title: item.title,
    excerpt: item.excerpt,
    retrievedAt: item.fetchedAt,
    observedAt: item.eventAt,
    availableAt: item.publishedAt ?? item.eventAt ?? item.fetchedAt,
    instrument: item.instrumentIds.length === 1 ? item.instrumentIds[0] : undefined,
    currency: item.currency,
    periodStart: item.eventAt?.slice(0, 10),
    periodEnd: item.eventAt?.slice(0, 10),
    quality: Math.max(0, Math.min(1, item.scores.reranker ?? item.scores.fused)),
    supports: [`document:${item.documentId}`],
  };
}

function documentFilter(need: DocumentNeed): {
  issuerIds: readonly string[];
  instrumentIds: readonly string[];
  kinds: DocumentNeed["kinds"];
  temporal?: { field: "published"; from?: string; to?: string };
} {
  const explicitIntervals = need.intervals.filter(
    (interval) => interval.source !== "default"
  );
  const starts = explicitIntervals
    .map((interval) => interval.startSession)
    .sort();
  const ends = explicitIntervals.map((interval) => interval.endSession).sort();
  return {
    issuerIds: need.entityIds,
    instrumentIds: need.entityIds,
    kinds: need.kinds,
    ...(starts[0] || ends.at(-1)
      ? {
          temporal: {
            field: "published" as const,
            ...(starts[0] ? { from: `${starts[0]}T00:00:00.000Z` } : {}),
            ...(ends.at(-1)
              ? { to: `${ends.at(-1)}T23:59:59.999Z` }
              : {}),
          },
        }
      : {}),
  };
}

async function executePlan(
  plan: GreenfieldExecutionPlan,
  dependencies: GreenfieldDependencies
): Promise<ExecutionArtifacts> {
  const failures: ExecutionArtifacts["failures"] = [];
  const retrievedAt = new Date().toISOString();
  let documentDiagnostics: HybridRetrievalResult["diagnostics"] | undefined;
  const results = await Promise.all(
    plan.needs.map(async (need): Promise<ResearchEvidence[]> => {
      try {
        if (need.kind === "market_data") {
          const run =
            dependencies.market ??
            ((item: MarketDataNeed, deps?: RangeBarDependencies) =>
              getBarsForRange(
                {
                  ticker: item.entity.ticker as string,
                  venue: venueFor(item.entity),
                  calendar: item.interval.calendar,
                  granularity: "1Day",
                  startSession: item.fetchStartSession,
                  endSession: item.fetchEndSession,
                  adjusted: true,
                },
                deps
              ));
          const series = await run(need, dependencies.marketDependencies);
          const evidence = marketEvidence(need, series, retrievedAt);
          return evidence ? [evidence] : [];
        }
        if (need.kind === "security_master") {
          const run =
            dependencies.security ??
            ((item: SecurityMasterNeed, options?: SecurityMasterOptions) =>
              resolveSecurity(
                {
                  ticker: item.entity.ticker,
                  name: item.entity.name,
                },
                { ...options, venue: venueFor(item.entity) }
              ));
          const security = await run(need, dependencies.securityOptions);
          return security
            ? [securityEvidence(need, security, retrievedAt)]
            : need.entity.private
              ? [privateCompanyEvidence(need, retrievedAt)]
              : [];
        }
        if (need.kind === "company_facts") {
          const run =
            dependencies.companyFacts ??
            ((item: CompanyFactsNeed, deps?: SecEdgarDependencies) =>
              getSecCompanyFacts(
                {
                  ticker: item.entity.ticker,
                  concepts: item.concepts,
                  latestOnly: true,
                },
                deps
              ));
          return (
            await run(need, dependencies.secDependencies)
          ).map((fact) => companyFactEvidence(need, fact, retrievedAt));
        }
        if (need.kind === "concept_knowledge") {
          const concept = findFinanceConcept(need.labels);
          return concept ? [conceptEvidence(concept, retrievedAt)] : [];
        }
        const documentPorts =
          dependencies.documents ??
          (await createProductionHybridDocumentPorts({
            queryId: need.id,
            query: need.query,
            entities: plan.entities,
            kinds: need.kinds,
            intervals: need.intervals,
            now: new Date(plan.asOf),
          }));
        const result = await retrieveDocumentsHybrid({
          query: {
            queryId: need.id,
            text: need.query,
            currentAsk: need.currentAsk,
            allowSemantic: true,
            allowLive: true,
            minimumArchiveResults: 3,
            filter: documentFilter(need),
          },
          ports: documentPorts,
        });
        documentDiagnostics = result.diagnostics;
        return result.items.map(documentEvidence);
      } catch (error) {
        failures.push({ needId: need.id, error: errorText(error) });
        return [];
      }
    })
  );
  return {
    evidence: results.flat(),
    documentDiagnostics,
    failures,
  };
}

async function executePlannedResearch(
  plan: GreenfieldExecutionPlan,
  dependencies: GreenfieldDependencies
): Promise<ExecutionArtifacts> {
  if (plan.answerDepth !== "deep" || plan.needs.length === 0) {
    return executePlan(plan, dependencies);
  }
  const failures: ExecutionArtifacts["failures"] = [];
  let documentDiagnostics: HybridRetrievalResult["diagnostics"] | undefined;
  const needById = new Map(plan.needs.map((need) => [need.id, need]));
  const researchPlan = createResearchPlan({
    id: `research:${plan.turnId}`,
    question: plan.standaloneQuery,
    depth: "deep",
    asOf: plan.asOf,
    lanes: plan.needs.map((need, index) => ({
      id: need.id,
      kind: need.kind,
      query:
        need.kind === "documents"
          ? need.query
          : `${need.kind} evidence for ${
              "entity" in need ? need.entity.name : plan.standaloneQuery
            }`,
      priority: plan.needs.length - index,
      estimatedCost: need.kind === "documents" ? 2 : 1,
      maxItems: need.kind === "company_facts" ? 12 : 8,
    })),
    limits: {
      maxSteps: plan.needs.length,
      maxParallel: Math.min(4, plan.needs.length),
    },
    sufficiency: {
      minCompletedLanes: Math.min(3, plan.needs.length),
      minEvidence: Math.min(6, Math.max(1, plan.needs.length)),
      minIndependentSources: Math.min(3, Math.max(1, plan.needs.length)),
    },
  });
  const record = await runResearchPlan(researchPlan, {
    persistence:
      dependencies.researchPersistence ?? (await defaultResearchPersistence()),
    signal: dependencies.researchSignal,
    onProgress: dependencies.onResearchProgress,
    executeLane: async (lane) => {
      const need = needById.get(lane.id);
      if (!need) throw new Error(`Unknown research lane: ${lane.id}`);
      const result = await executePlan(
        { ...plan, needs: [need], answerDepth: "standard" },
        dependencies
      );
      failures.push(...result.failures);
      documentDiagnostics =
        result.documentDiagnostics ?? documentDiagnostics;
      return { evidence: result.evidence, cost: lane.estimatedCost ?? 1 };
    },
  });
  return {
    evidence: record.evidence,
    documentDiagnostics,
    researchRun: record,
    failures,
  };
}

function clarification(
  interpretation: SemanticInterpretation,
  hasActiveEntityContext: boolean
): string | null {
  const material = interpretation.semantic.ambiguities.filter(
    (ambiguity) => {
      if (!ambiguity.requiresClarification) return false;
      if (ambiguity.field === "entity") {
        const unresolved = interpretation.grounding.issues.some(
          (issue) => issue.code === "entity_unresolved"
        );
        if (
          !unresolved ||
          interpretation.grounding.inheritedEntities.length > 0 ||
          (hasActiveEntityContext &&
            (interpretation.semantic.entities.inheritance.mode !== "none" ||
              interpretation.semantic.informationNeeds.some(
                (need) => need.kind === "listing_status"
              )))
        ) {
          return false;
        }
      }
      if (
        ambiguity.field === "group" &&
        interpretation.grounding.groups.length > 0 &&
        interpretation.grounding.groups.every(
          (group) => group.status === "grounded"
        )
      ) {
        return false;
      }
      return true;
    }
  );
  if (material.length > 0) {
    const first = material[0];
    const choices =
      first.candidates.length > 0 ? ` Options: ${first.candidates.join(", ")}.` : "";
    return `${first.reason}${choices}`;
  }
  const hasExplicitGrounding =
    interpretation.grounding.entityMentions.some(
      (mention) => mention.status === "grounded"
    ) ||
    interpretation.grounding.groups.some(
      (group) => group.status === "grounded"
    );
  const blocking = interpretation.grounding.issues.find(
    (issue) =>
      ["entity_unresolved", "group_unresolved", "group_ambiguous"].includes(
        issue.code
      ) ||
      (issue.code === "inheritance_unavailable" && !hasExplicitGrounding)
  );
  return blocking?.message ?? null;
}

function historicalCutoff(
  intervals: readonly TemporalInterval[],
  now: Date
): string | undefined {
  const explicit = intervals.filter((interval) => interval.source !== "default");
  if (explicit.length === 0) return undefined;
  const latest = explicit
    .map((interval) => interval.endSession)
    .sort()
    .at(-1);
  return latest ? `${latest}T23:59:59.999Z` : now.toISOString();
}

function atomicTask(
  plan: GreenfieldExecutionPlan,
  evidence: readonly ResearchEvidence[]
): AtomicNumericTask | undefined {
  const market = evidence.filter((item) => item.id.startsWith("market:"));
  if (
    plan.comparison ||
    market.length !== 1 ||
    plan.needs.some((need) => need.kind === "documents")
  ) {
    return undefined;
  }
  const item = market[0];
  const rangeReturn =
    item.periodStart !== item.periodEnd &&
    typeof item.facts?.returnPct?.value === "number";
  const factKey = rangeReturn ? "returnPct" : "close";
  if (typeof item.facts?.[factKey]?.value !== "number") return undefined;
  return {
    operation: "average",
    operands: [{ evidenceId: item.id, factKey }],
    label: rangeReturn
      ? `${item.instrument ?? item.title ?? "Security"} return from ${
          item.periodStart
        } to ${item.periodEnd}`
      : item.title,
    ...(rangeReturn ? { unit: "%" } : { currency: item.currency }),
    precision: 2,
  };
}

function deterministicMarketComparison(
  plan: GreenfieldExecutionPlan,
  evidence: readonly ResearchEvidence[]
): ComposerDraft | null {
  if (
    !plan.comparison ||
    plan.needs.some(
      (need) =>
        need.kind === "documents" ||
        need.kind === "company_facts" ||
        need.kind === "concept_knowledge"
    )
  ) {
    return null;
  }
  const market = evidence.filter(
    (item) =>
      item.id.startsWith("market:") &&
      (typeof item.facts?.returnPct?.value === "number" ||
        typeof item.facts?.close?.value === "number")
  );
  const privateCompanies = evidence.filter(
    (item) => item.facts?.private?.value === true
  );
  if (market.length + privateCompanies.length < 2) return null;
  const rows = market.map((item) => {
    const rangeReturn =
      item.periodStart !== item.periodEnd &&
      typeof item.facts?.returnPct?.value === "number";
    const factKey = rangeReturn ? "returnPct" : "close";
    const value = item.facts?.[factKey]?.value as number;
    const unit = rangeReturn ? "%" : item.currency;
    return { item, factKey, value, unit };
  });
  const claims: Array<ComposerDraft["claims"][number]> = rows.map(
    ({ item, factKey, value, unit }, index) => ({
      id: `market-value-${index + 1}`,
      kind: "factual",
      text: `${item.title ?? item.instrument ?? "Requested market value"}: ${
        unit === "%" ? `${value.toFixed(2)}%` : `${unit ? `${unit} ` : ""}${value.toFixed(2)}`
      }.`,
      evidenceIds: [item.id],
      factRefs: [{ evidenceId: item.id, factKey }],
      instrument: item.instrument,
      currency: factKey === "close" ? item.currency : undefined,
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
    })
  );
  claims.push(
    ...privateCompanies.map(
      (item, index): ComposerDraft["claims"][number] => ({
        id: `private-status-${index + 1}`,
        kind: "factual",
        text: `${item.title?.replace(/ ownership status$/, "") ?? "The company"} is privately held, so no public-market price return is available.`,
        evidenceIds: [item.id],
        factRefs: [{ evidenceId: item.id, factKey: "private" }],
      })
    )
  );
  if (rows.length === 2 && rows[0].factKey === rows[1].factKey) {
    const difference = rows[0].value - rows[1].value;
    const direction =
      difference === 0 ? "equal to" : difference > 0 ? "higher than" : "lower than";
    claims.push({
      id: "market-difference",
      kind: "derived",
      text:
        difference === 0
          ? `${rows[0].item.title} was equal to ${rows[1].item.title}.`
          : `${rows[0].item.title} was ${Math.abs(difference).toFixed(2)}${
              rows[0].unit === "%" ? " percentage points" : ` ${rows[0].unit ?? "units"}`
            } ${direction} ${rows[1].item.title}.`,
      evidenceIds: [rows[0].item.id, rows[1].item.id],
      factRefs: rows.map((row) => ({
        evidenceId: row.item.id,
        factKey: row.factKey,
      })),
      calculation: {
        operation: "difference",
        operands: rows.map((row) => ({
          evidenceId: row.item.id,
          factKey: row.factKey,
        })),
        result: difference,
      },
      currency:
        rows[0].factKey === "close" &&
        rows[0].item.currency === rows[1].item.currency
          ? rows[0].item.currency
          : undefined,
    });
  }
  return { claims };
}

function unavailableText(plan: GreenfieldExecutionPlan, failures: ExecutionArtifacts["failures"]): string {
  const period =
    plan.intervals.length > 0
      ? ` for ${plan.intervals.map((item) => item.label).join(" versus ")}`
      : "";
  const historical = plan.intervals.some(
    (interval) => interval.source !== "default"
  );
  if (historical) {
    return `I understood the request, but the requested historical evidence${period} was unavailable. No current-period figure was substituted.`;
  }
  return failures.length > 0
    ? `I understood the request, but the required evidence${period} could not be retrieved. No current-period figure was substituted.`
    : `I understood the request, but no verified evidence was available${period}. No unsupported figure was substituted.`;
}

function deterministicListingStatus(
  entities: readonly FinanceEntity[]
): string | null {
  if (entities.length === 0) return null;
  const lines = entities.flatMap((entity) => {
    if (entity.private) {
      return [
        `${entity.name} is privately held, so it has no public exchange ticker to buy.`,
      ];
    }
    if (entity.ticker) {
      const symbol =
        entity.market === "au" ? `ASX:${entity.ticker}` : entity.ticker;
      return [`${entity.name} is publicly traded as ${symbol}.`];
    }
    return [];
  });
  return lines.length > 0 ? lines.join("\n\n") : null;
}

export async function runGreenfieldTurn(
  request: GreenfieldRequest,
  dependencies: GreenfieldDependencies = {}
): Promise<GreenfieldReply> {
  const message = request.message.trim();
  const ledger = request.ledger ?? createConversationLedger();
  const turnId = randomUUID();
  const emptyTrace: GreenfieldTrace = {
    turnId,
    evidence: [],
    failures: [],
  };

  const crisis = detectCrisis(message);
  if (crisis) {
    return {
      kind: "safety_support",
      text: crisisResponse(crisis),
      ledger,
      trace: emptyTrace,
    };
  }
  if (detectViolenceThreat(message)) {
    return {
      kind: "safety_support",
      text: VIOLENCE_THREAT_RESPONSE,
      ledger,
      trace: emptyTrace,
    };
  }

  const priorContext = ledgerInterpreterContext(ledger);
  const provisionalCalendar = calendarFor(priorContext.activeEntities);
  const interpreter = createSemanticInterpreter(dependencies.semanticModel);
  const provisional = await interpreter({
    turnId,
    message,
    now: request.now ?? new Date(),
    calendar: provisionalCalendar,
    context: priorContext,
  });
  const entities = [
    ...provisional.grounding.entityMentions.flatMap((item) =>
      item.entity ? [item.entity] : []
    ),
    ...provisional.grounding.inheritedEntities,
    ...provisional.grounding.groups.flatMap((group) => group.memberEntities),
  ];
  const calendar = calendarFor(entities);
  const compiledTemporal = compileTemporalSpecs(
    provisional.semantic.temporal.specs.length > 0
      ? provisional.semantic.temporal.specs
      : provisional.semantic.temporal.inherit === "active"
        ? priorContext.activeTemporal
        : [],
    { now: request.now ?? new Date(), calendar }
  );
  const interpretation: SemanticInterpretation = {
    ...provisional,
    compiledTemporal,
    standaloneQuery: rewriteContextualQuery(
      provisional.semantic,
      provisional.grounding,
      priorContext,
      compiledTemporal
    ),
  };
  const nextLedger = appendConversationTurn(ledger, interpretation);
  const traceBase = { ...emptyTrace, interpretation };

  const clarificationText = clarification(
    interpretation,
    priorContext.activeEntities.length > 0
  );
  if (clarificationText) {
    return {
      kind: "clarification",
      text: clarificationText,
      ledger: nextLedger,
      trace: traceBase,
    };
  }
  if (
    interpretation.semantic.intent.kind === "prohibited" ||
    interpretation.semantic.intent.kind === "out_of_scope"
  ) {
    return {
      kind: "refused",
      text:
        interpretation.semantic.intent.kind === "prohibited"
          ? "I can’t help with that. I can help analyze markets, companies, and investment risk."
          : "I focus on company and market research. Ask me about a business, security, filing, market, or economic trend.",
      ledger: nextLedger,
      trace: traceBase,
    };
  }
  if (interpretation.semantic.intent.kind === "social") {
    return {
      kind: "answer",
      text: "Hey. What company, investment, market, or finance concept are you looking into?",
      ledger: nextLedger,
      trace: traceBase,
    };
  }
  if (interpretation.semantic.intent.kind === "capability") {
    return {
      kind: "answer",
      text: "I can explain finance concepts, research public and private companies, compare investments on a consistent basis, inspect market history and filings, and trace current claims to sources. I’ll ask when a material reference is ambiguous, and I won’t place trades or promise returns.",
      ledger: nextLedger,
      trace: traceBase,
    };
  }
  if (
    interpretation.semantic.intent.kind === "correction" &&
    interpretation.semantic.informationNeeds.length === 0
  ) {
    const corrected = latestLedgerState(nextLedger);
    const subjects = corrected?.entities.map((entity) => entity.name) ?? [];
    return {
      kind: "answer",
      text:
        subjects.length > 0
          ? `Got it — I’ll use ${subjects.join(" and ")} as the active context.`
          : "Got it — I’ve updated the active context.",
      ledger: nextLedger,
      trace: traceBase,
    };
  }
  if (
    interpretation.semantic.informationNeeds.some(
      (need) => need.kind === "listing_status"
    )
  ) {
    const listing = deterministicListingStatus(
      latestLedgerState(nextLedger)?.entities ?? []
    );
    if (listing) {
      return {
        kind: "answer",
        text: listing,
        ledger: nextLedger,
        trace: traceBase,
      };
    }
  }
  if (interpretation.semantic.intent.kind === "high_stakes_finance") {
    return {
      kind: "safety_support",
      text: "I can help you examine the evidence and concentration risks, but I can’t tell you to put essential savings into one security or promise a return.",
      ledger: nextLedger,
      trace: traceBase,
    };
  }

  const state = latestLedgerState(nextLedger);
  if (!state) throw new Error("Greenfield ledger did not materialize a state");
  const now = request.now ?? new Date();
  const plan = planGreenfieldTurn({
    interpretation,
    state,
    calendar,
    now,
  });
  const artifacts = await executePlannedResearch(plan, dependencies);
  const trace: GreenfieldTrace = {
    ...traceBase,
    plan,
    evidence: artifacts.evidence,
    documentDiagnostics: artifacts.documentDiagnostics,
    researchRun: artifacts.researchRun,
    failures: artifacts.failures,
  };
  if (artifacts.evidence.length === 0) {
    return {
      kind: "unavailable",
      text: unavailableText(plan, artifacts.failures),
      ledger: nextLedger,
      trace,
    };
  }

  const deterministicDraft = deterministicMarketComparison(
    plan,
    artifacts.evidence
  );
  const answer = await answerAdaptively({
    question: interpretation.standaloneQuery,
    preference:
      plan.answerDepth === "brief"
        ? "glance"
        : plan.answerDepth === "deep"
          ? "deep"
          : "standard",
    evidence: artifacts.evidence,
    entityCount: plan.entities.length,
    comparison: plan.comparison,
    causal: plan.causal,
    multiStep: plan.needs.length > 2,
    requiresResearch: plan.answerDepth === "deep",
    numericTask:
      ["entity_snapshot", "metric_lookup"].includes(
        interpretation.semantic.intent.kind
      )
        ? atomicTask(plan, artifacts.evidence)
        : undefined,
    composer:
      deterministicDraft !== null
        ? async () => deterministicDraft
        : dependencies.composer ?? defaultStructuredComposer,
    alignment: {
      asOf: historicalCutoff(plan.intervals, now),
      instruments: plan.entities.flatMap((entity) => {
        if (!entity.ticker) return [];
        return entity.market === "au"
          ? [entity.ticker, `ASX:${entity.ticker}`]
          : [entity.ticker];
      }),
      periodStart: plan.intervals.map((item) => item.startSession).sort()[0],
      periodEnd: plan.intervals.map((item) => item.endSession).sort().at(-1),
    },
    unsupportedPolicy: "qualify",
  });
  return {
    kind: answer.text ? "answer" : "unavailable",
    text:
      answer.text ||
      "The retrieved evidence did not support a publishable answer. No unsupported claim was substituted.",
    ledger: nextLedger,
    answer,
    trace,
  };
}

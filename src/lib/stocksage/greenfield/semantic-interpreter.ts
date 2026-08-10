import { GROQ_CHAT_MODEL, GROQ_FALLBACK_MODEL } from "@/lib/config";
import { groqChatJSON, groqErrorSummary } from "@/lib/groq";
import { CANONICAL_GROUPS, WEB_ALIASES } from "../entity-catalog";
import { normalizeOrderedReference } from "../entity-state-helpers";
import { resolveEntityHints } from "../entity-hints";
import { groupMembers } from "../entity-resolution";
import { isWithinOneEdit } from "../text-normalization";
import {
  addDays,
  currentSession,
  isTradingSession,
  previousSession,
  type MarketCalendar,
  type TemporalInterval,
} from "../temporal";
import type { FinanceEntity } from "../types";
import {
  SemanticTurnSchema,
  type GroupCandidate,
  type SemanticTurn,
  type TemporalAnchor,
  type TemporalSpec,
  type TemporalValue,
} from "./semantic-schema";
import {
  expandSemanticExtraction,
  SEMANTIC_EXTRACTION_JSON_SCHEMA,
} from "./semantic-wire";

export type SemanticInterpreterContext = {
  activeEntities: readonly FinanceEntity[];
  activeGroups: readonly {
    id: string;
    label: string;
    memberIds: readonly string[];
  }[];
  activeTemporal: readonly TemporalSpec[];
  recentTurnIds: readonly string[];
};

export type SemanticInterpretationInput = {
  turnId: string;
  message: string;
  now: Date;
  calendar: MarketCalendar;
  context?: SemanticInterpreterContext;
};

export type SemanticModelRequest = {
  system: string;
  user: string;
};

/**
 * The sole model seam. Unit tests inject this function; production supplies
 * the one Groq JSON implementation below.
 */
export type SemanticJsonModel = (
  request: SemanticModelRequest
) => Promise<unknown>;

export type GroundedEntityMention = {
  mentionId: string;
  status: "grounded" | "unresolved";
  confidence: number;
  entity?: FinanceEntity;
};

export type GroundedGroupCandidate = {
  mention: string;
  candidateIds: readonly string[];
  selectedId?: string;
  canonicalLabel?: string;
  status: "grounded" | "ambiguous" | "unresolved";
  memberEntities: readonly FinanceEntity[];
  confidence: number;
};

export type SemanticValidationIssue = {
  code:
    | "entity_unresolved"
    | "group_unresolved"
    | "group_ambiguous"
    | "inheritance_unavailable"
    | "source_turn_unavailable";
  field: string;
  message: string;
};

export type SemanticGrounding = {
  entityMentions: readonly GroundedEntityMention[];
  inheritedEntities: readonly FinanceEntity[];
  groups: readonly GroundedGroupCandidate[];
  issues: readonly SemanticValidationIssue[];
};

export type CompiledTemporalSpec = {
  id: string;
  kind: TemporalSpec["kind"];
  label: string;
  intervals: readonly TemporalInterval[];
  assumptionId?: string;
};

export type SemanticInterpretation = {
  semantic: SemanticTurn;
  grounding: SemanticGrounding;
  compiledTemporal: readonly CompiledTemporalSpec[];
  standaloneQuery: string;
};

const EMPTY_CONTEXT: SemanticInterpreterContext = {
  activeEntities: [],
  activeGroups: [],
  activeTemporal: [],
  recentTurnIds: [],
};

const SEMANTIC_SYSTEM_PROMPT = `You are StockSage's meaning extractor.
Return exactly one JSON object and no prose. Extract meaning only: never answer
the user, calculate a value, recommend a trade, execute an action, or invent a
fact. Natural-language matching is your job; deterministic code will validate
and ground your structured output.
Interpret semanticText when it differs from originalText; it contains only
deterministic typo normalization for contextual references.

Return the compact extraction schema exactly. needs is an array of need-kind
enums, not prose. entities.mentions contains the user's entity references;
deterministic code creates IDs and confidence fields. inheritance has mode,
sourceTurnId, entityIds, orderedPositions, and groupId.
intent is exactly one of social, capability, entity_snapshot,
entity_comparison, metric_lookup, causal_analysis, concept_explanation,
outlook_research, correction, clarification, high_stakes_finance, prohibited,
safety_support, out_of_scope.
needs entries are exactly definition, current_state, price_performance,
fundamentals, valuation, risk, catalyst, cause, ranking, comparison,
listing_status, or source_check.
Questions about whether an entity is public, listed, tradable, or available on
an exchange require listing_status.
Use inheritance.mode "none" when explicit entity mentions fully identify the
requested scope; explicit names such as "Tesla" are not inherited references.
Every array must be present, including when empty.

Only use group candidate IDs supplied in context. When several candidates
remain plausible, selectedId is null and ambiguities must request clarification.

temporal specs contain no resolved dates for relative language:
- point: kind, label, value, source
- range: kind, label, start, end, assumptionKey, source
- comparison: kind, label, left and right anchors, source
A temporal value is either {type:"absolute",date:"YYYY-MM-DD"} when the user
gave an absolute date, or {type:"relative",unit,amount,direction}. Relative
units are day/week/month/year and direction is past/future. An anchor has kind
point/range, label, and a value or start/end values. Preserve relative phrases
as offsets. Never calculate or emit resolved dates for relative offsets; the
deterministic compiler uses the supplied current instant and market calendar.
For "few" months, use amount 3 and add a linked, explicit temporal assumption
whose key matches the range assumptionKey.
"Over the last few months" is one range from a three-month past offset to a
zero-day past offset; it is not a point comparison. "N weeks ago" is one point.
"N years ago compared with M years ago" is one comparison containing two
separate point anchors; never collapse those anchors into a range.

The response schema requires every property to be present. For semantically
optional scalar fields such as ticker, listing, sourceTurnId, groupId,
selectedId, unit, assumptionKey, correction target/replacement/value, and topic
label, emit null when the field does not apply. Never omit those properties.`;

function modelUserPayload(
  input: SemanticInterpretationInput,
  context: SemanticInterpreterContext
): string {
  const semanticText = normalizeOrderedReference(
    input.message,
    context.activeEntities.length >= 2
  );
  return JSON.stringify({
    turnId: input.turnId,
    originalText: input.message,
    semanticText,
    context: {
      temporalReference: {
        currentInstant: input.now.toISOString(),
        currentDate: input.now.toISOString().slice(0, 10),
        marketCalendar: input.calendar,
      },
      activeEntities: context.activeEntities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        ticker: entity.ticker,
        market: entity.market,
      })),
      activeGroups: context.activeGroups,
      activeTemporal: context.activeTemporal,
      recentTurnIds: context.recentTurnIds,
      canonicalGroupCandidates: CANONICAL_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        members: group.members,
      })),
    },
  });
}

export const groqSemanticJsonModel: SemanticJsonModel = async (request) => {
  const payload = JSON.parse(request.user) as {
    turnId: string;
    originalText: string;
  };
  const interpret = async (model: string) => {
    const raw = await groqChatJSON({
      model,
      system: request.system,
      user: request.user,
      temperature: 0,
      maxTokens: 1_500,
      jsonSchema: {
        name: "semantic_extraction",
        schema: SEMANTIC_EXTRACTION_JSON_SCHEMA,
        strict: true,
      },
    });
    return expandSemanticExtraction({
      raw,
      turnId: payload.turnId,
      originalText: payload.originalText,
    });
  };
  try {
    return await interpret(GROQ_CHAT_MODEL);
  } catch (error) {
    const summary = groqErrorSummary(error);
    if (
      GROQ_FALLBACK_MODEL === GROQ_CHAT_MODEL ||
      (summary.status !== undefined &&
        summary.status !== 429 &&
        summary.status < 500)
    ) {
      throw error;
    }
    return interpret(GROQ_FALLBACK_MODEL);
  }
};

function uniqueEntities(values: readonly FinanceEntity[]): FinanceEntity[] {
  return [...new Map(values.map((entity) => [entity.id, entity])).values()];
}

function isCatalogGrounded(
  entity: FinanceEntity,
  known: readonly FinanceEntity[]
): boolean {
  if (known.some((candidate) => candidate.id === entity.id)) return true;
  if (entity.market !== "web" || Boolean(entity.ticker)) return true;
  return WEB_ALIASES.some(
    (alias) =>
      alias.name === entity.name ||
      (alias.ticker && alias.ticker === entity.ticker)
  );
}

function groundEntityMentions(
  semantic: SemanticTurn,
  context: SemanticInterpreterContext
): GroundedEntityMention[] {
  const normalizedMessage = normalizeOrderedReference(
    semantic.originalText,
    context.activeEntities.length >= 2
  ).toLowerCase();
  let orderedIndex = 0;
  return semantic.entities.mentions.map((mention) => {
    const orderedSurface = mention.surface
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .some(
        (token) =>
          isWithinOneEdit(token, "former") ||
          isWithinOneEdit(token, "latter")
      );
    if (
      (mention.reference === "ordered" || orderedSurface) &&
      context.activeEntities.length > 0
    ) {
      const requested =
        semantic.entities.inheritance.orderedPositions[orderedIndex];
      orderedIndex += 1;
      const position =
        requested === "former" || requested === "first"
          ? 0
          : requested === "second"
            ? 1
            : requested === "latter"
              ? context.activeEntities.length - 1
              : /\b(?:latter|second)\b/.test(normalizedMessage)
                ? context.activeEntities.length - 1
                : /\b(?:former|first)\b/.test(normalizedMessage)
                  ? 0
                  : -1;
      const ordered =
        position >= 0 ? context.activeEntities[position] : undefined;
      return {
        mentionId: mention.mentionId,
        status: ordered ? ("grounded" as const) : ("unresolved" as const),
        confidence: mention.confidence,
        ...(ordered ? { entity: ordered } : {}),
      };
    }
    const entity = resolveEntityHints(
      [
        {
          name: mention.canonicalName ?? mention.surface,
          ticker: mention.ticker,
        },
      ],
      [...context.activeEntities]
    )[0];
    const grounded =
      entity && isCatalogGrounded(entity, context.activeEntities)
        ? entity
        : undefined;
    return {
      mentionId: mention.mentionId,
      status: grounded ? ("grounded" as const) : ("unresolved" as const),
      confidence: mention.confidence,
      ...(grounded ? { entity: grounded } : {}),
    };
  });
}

function groundGroups(
  candidates: readonly GroupCandidate[]
): GroundedGroupCandidate[] {
  const catalogIds = new Set(CANONICAL_GROUPS.map((group) => group.id));
  return candidates.map((candidate) => {
    const candidateIds = [
      ...new Set(candidate.candidateIds.filter((id) => catalogIds.has(id))),
    ];
    const selectedId =
      candidate.selectedId && candidateIds.includes(candidate.selectedId)
        ? candidate.selectedId
        : candidateIds.length === 1
          ? candidateIds[0]
          : undefined;
    const group = selectedId
      ? CANONICAL_GROUPS.find((item) => item.id === selectedId)
      : undefined;
    const status =
      candidateIds.length === 0
        ? ("unresolved" as const)
        : selectedId
          ? ("grounded" as const)
          : ("ambiguous" as const);
    return {
      mention: candidate.mention,
      candidateIds,
      selectedId,
      ...(group ? { canonicalLabel: group.label } : {}),
      status,
      memberEntities: group ? groupMembers([group]) : [],
      confidence: candidate.confidence,
    };
  });
}

function normalizedPhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function phrasesOverlap(left: string, right: string): boolean {
  const a = normalizedPhrase(left);
  const b = normalizedPhrase(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function relevantGroupCandidates(semantic: SemanticTurn): GroupCandidate[] {
  const groupMentions = semantic.entities.mentions.filter(
    (mention) =>
      mention.reference === "category" || mention.reference === "group_member"
  );
  return semantic.entities.groupCandidates.filter(
    (candidate) =>
      phrasesOverlap(semantic.originalText, candidate.mention) ||
      groupMentions.some((mention) =>
        phrasesOverlap(mention.surface, candidate.mention)
      ) ||
      (semantic.entities.inheritance.mode === "group" &&
        Boolean(
          semantic.entities.inheritance.groupId &&
            (candidate.selectedId === semantic.entities.inheritance.groupId ||
              candidate.candidateIds.includes(
                semantic.entities.inheritance.groupId
              ))
        ))
  );
}

function inheritedEntities(
  semantic: SemanticTurn,
  context: SemanticInterpreterContext,
  currentGroups: readonly GroundedGroupCandidate[]
): FinanceEntity[] {
  const inheritance = semantic.entities.inheritance;
  if (inheritance.mode === "none") return [];

  const byId = new Map(
    context.activeEntities.map((entity) => [entity.id, entity])
  );
  if (inheritance.entityIds.length > 0) {
    return uniqueEntities(
      inheritance.entityIds
        .map((id) => byId.get(id))
        .filter((entity): entity is FinanceEntity => Boolean(entity))
    );
  }

  if (inheritance.mode === "singular") {
    return context.activeEntities.slice(-1);
  }
  if (
    inheritance.mode === "plural" ||
    inheritance.mode === "all_active"
  ) {
    return [...context.activeEntities];
  }
  if (inheritance.mode === "ordered") {
    const positions = inheritance.orderedPositions.map((position) =>
      position === "former" || position === "first"
        ? 0
        : position === "second"
          ? 1
          : context.activeEntities.length - 1
    );
    return uniqueEntities(
      positions
        .map((position) => context.activeEntities[position])
        .filter((entity): entity is FinanceEntity => Boolean(entity))
    );
  }

  const requestedGroupId = inheritance.groupId;
  const priorGroup = context.activeGroups.find(
    (group) => group.id === requestedGroupId
  );
  if (priorGroup) {
    const memberIds = new Set(priorGroup.memberIds);
    return context.activeEntities.filter((entity) => memberIds.has(entity.id));
  }
  return uniqueEntities(
    currentGroups
      .filter(
        (group) =>
          group.status === "grounded" &&
          (!requestedGroupId || group.selectedId === requestedGroupId)
      )
      .flatMap((group) => group.memberEntities)
  );
}

export function groundSemanticTurn(
  semantic: SemanticTurn,
  context: SemanticInterpreterContext = EMPTY_CONTEXT
): SemanticGrounding {
  const entityMentions = groundEntityMentions(semantic, context);
  const groups = groundGroups(relevantGroupCandidates(semantic));
  const inherited = inheritedEntities(semantic, context, groups);
  const issues: SemanticValidationIssue[] = [];

  for (const mention of entityMentions) {
    if (mention.status === "unresolved") {
      const source = semantic.entities.mentions.find(
        (item) => item.mentionId === mention.mentionId
      );
      const coveredByGroundedGroup =
        source !== undefined &&
        groups.some(
          (group) =>
            group.status === "grounded" &&
            phrasesOverlap(source.surface, group.mention)
        );
      if (coveredByGroundedGroup) continue;
      issues.push({
        code: "entity_unresolved",
        field: `entities.mentions.${mention.mentionId}`,
        message: `Entity mention ${mention.mentionId} did not ground to the catalog or active context.`,
      });
    }
  }
  for (const group of groups) {
    if (group.status === "ambiguous") {
      issues.push({
        code: "group_ambiguous",
        field: "entities.groupCandidates",
        message: `Group "${group.mention}" has multiple valid candidates.`,
      });
    } else if (group.status === "unresolved") {
      issues.push({
        code: "group_unresolved",
        field: "entities.groupCandidates",
        message: `Group "${group.mention}" is not in the canonical catalog.`,
      });
    }
  }

  const inheritance = semantic.entities.inheritance;
  if (
    inheritance.mode !== "none" &&
    inherited.length === 0 &&
    context.activeEntities.length === 0
  ) {
    issues.push({
      code: "inheritance_unavailable",
      field: "entities.inheritance",
      message: "The requested entity inheritance has no active referent.",
    });
  }
  if (
    inheritance.sourceTurnId &&
    !context.recentTurnIds.includes(inheritance.sourceTurnId)
  ) {
    issues.push({
      code: "source_turn_unavailable",
      field: "entities.inheritance.sourceTurnId",
      message: `Source turn ${inheritance.sourceTurnId} is not in context.`,
    });
  }

  return {
    entityMentions,
    inheritedEntities: inherited,
    groups,
    issues,
  };
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function shiftCalendarDate(
  base: string,
  value: Extract<TemporalValue, { type: "relative" }>
): string {
  const sign = value.direction === "past" ? -1 : 1;
  if (value.unit === "day" || value.unit === "week") {
    return addDays(base, sign * value.amount * (value.unit === "week" ? 7 : 1));
  }

  const date = new Date(`${base}T00:00:00.000Z`);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  if (value.unit === "month") {
    date.setUTCMonth(date.getUTCMonth() + sign * value.amount);
  } else {
    date.setUTCFullYear(date.getUTCFullYear() + sign * value.amount);
  }
  date.setUTCDate(
    Math.min(
      originalDay,
      lastDayOfMonth(date.getUTCFullYear(), date.getUTCMonth())
    )
  );
  return date.toISOString().slice(0, 10);
}

function snapSession(
  date: string,
  calendar: MarketCalendar,
  direction: "past" | "future"
): string {
  if (isTradingSession(date, calendar)) return date;
  if (direction === "past") return previousSession(date, calendar);
  let candidate = addDays(date, 1);
  for (let guard = 0; guard < 15; guard += 1) {
    if (isTradingSession(candidate, calendar)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error(`Could not find a ${calendar} session near ${date}`);
}

function resolveCalendarDate(
  value: TemporalValue,
  reference: string
): string {
  return value.type === "absolute"
    ? value.date
    : shiftCalendarDate(reference, value);
}

function compileAnchor(
  anchor: TemporalAnchor,
  reference: string,
  calendar: MarketCalendar,
  source: TemporalInterval["source"]
): TemporalInterval {
  if (anchor.kind === "point") {
    const session = snapSession(
      resolveCalendarDate(anchor.value, reference),
      calendar,
      "past"
    );
    return {
      version: 1,
      label: anchor.label,
      kind: "session",
      calendar,
      startSession: session,
      endSession: session,
      source,
      raw: anchor.label,
    };
  }
  const startSession = snapSession(
    resolveCalendarDate(anchor.start, reference),
    calendar,
    "future"
  );
  const endSession = snapSession(
    resolveCalendarDate(anchor.end, reference),
    calendar,
    "past"
  );
  if (startSession > endSession) {
    throw new RangeError(`Temporal range "${anchor.label}" ends before it starts`);
  }
  return {
    version: 1,
    label: anchor.label,
    kind: "range",
    calendar,
    startSession,
    endSession,
    source,
    raw: anchor.label,
  };
}

/**
 * Resolves validated temporal meaning into exchange sessions. The clock and
 * calendar are explicit inputs; an empty semantic specification stays empty.
 */
export function compileTemporalSpecs(
  specs: readonly TemporalSpec[],
  options: { now: Date; calendar: MarketCalendar }
): CompiledTemporalSpec[] {
  const reference = currentSession(options.calendar, options.now);
  return specs.map((spec) => {
    const source = spec.source;
    if (spec.kind === "point") {
      return {
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        intervals: [
          compileAnchor(
            { kind: "point", label: spec.label, value: spec.value },
            reference,
            options.calendar,
            source
          ),
        ],
      };
    }
    if (spec.kind === "range") {
      return {
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        intervals: [
          compileAnchor(
            {
              kind: "range",
              label: spec.label,
              start: spec.start,
              end: spec.end,
              ...(spec.assumptionId ? { assumptionId: spec.assumptionId } : {}),
            },
            reference,
            options.calendar,
            source
          ),
        ],
        ...(spec.assumptionId ? { assumptionId: spec.assumptionId } : {}),
      };
    }
    return {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      intervals: [
        compileAnchor(spec.left, reference, options.calendar, source),
        compileAnchor(spec.right, reference, options.calendar, source),
      ],
    };
  });
}

function temporalLabel(spec: TemporalSpec): string {
  const valueLabel = (value: TemporalValue): string =>
    value.type === "absolute"
      ? value.date
      : `${value.amount} ${value.unit}${value.amount === 1 ? "" : "s"} ${value.direction}`;
  const anchorLabel = (anchor: TemporalAnchor): string =>
    anchor.kind === "point"
      ? `${anchor.label} (${valueLabel(anchor.value)})`
      : `${anchor.label} (${valueLabel(anchor.start)} through ${valueLabel(anchor.end)})`;
  if (spec.kind === "point") {
    return `${spec.label} (${valueLabel(spec.value)})`;
  }
  if (spec.kind === "range") {
    return `${spec.label} (${valueLabel(spec.start)} through ${valueLabel(spec.end)})`;
  }
  return `${spec.label}: ${anchorLabel(spec.left)} versus ${anchorLabel(spec.right)}`;
}

function compiledTemporalLabel(spec: CompiledTemporalSpec): string {
  return spec.intervals
    .map(
      (interval) =>
        `${interval.label} (${interval.startSession} through ${interval.endSession}, ${interval.calendar})`
    )
    .join(" versus ");
}

/**
 * Builds a context-complete retrieval query only from validated structure.
 * It performs no natural-language classification and produces no answer.
 */
export function rewriteContextualQuery(
  semantic: SemanticTurn,
  grounding: SemanticGrounding,
  context: SemanticInterpreterContext = EMPTY_CONTEXT,
  compiledTemporal?: readonly CompiledTemporalSpec[]
): string {
  const explicit = grounding.entityMentions
    .filter((item) => item.status === "grounded" && item.entity)
    .map((item) => item.entity as FinanceEntity);
  const groupMembers = grounding.groups.flatMap((group) =>
    group.status === "grounded" ? group.memberEntities : []
  );
  const subjects = uniqueEntities([
    ...explicit,
    ...grounding.inheritedEntities,
    ...groupMembers,
  ]).map((entity) =>
    entity.ticker ? `${entity.name} (${entity.ticker})` : entity.name
  );
  const temporal =
    semantic.temporal.specs.length > 0
      ? semantic.temporal.specs
      : semantic.temporal.inherit === "active"
        ? context.activeTemporal
        : [];
  const parts = [
    `Intent: ${semantic.intent.kind}`,
    `User request: ${semantic.originalText}`,
    ...(subjects.length > 0 ? [`Subjects: ${subjects.join(", ")}`] : []),
    ...(semantic.metrics.length > 0
      ? [
          `Metrics: ${semantic.metrics
            .map((metric) => `${metric.name} [${metric.operation}]`)
            .join(", ")}`,
        ]
      : []),
    ...(temporal.length > 0
      ? [
          `Time: ${
            compiledTemporal && compiledTemporal.length > 0
              ? compiledTemporal.map(compiledTemporalLabel).join("; ")
              : temporal.map(temporalLabel).join("; ")
          }`,
        ]
      : []),
    ...(semantic.comparison.kind !== "none"
      ? [`Comparison: ${semantic.comparison.kind}`]
      : []),
    ...(semantic.informationNeeds.length > 0
      ? [
          `Information needed: ${semantic.informationNeeds
            .map((need) => need.question)
            .join("; ")}`,
        ]
      : []),
  ];
  return parts.join(". ");
}

export function createSemanticInterpreter(
  model: SemanticJsonModel = groqSemanticJsonModel
): (input: SemanticInterpretationInput) => Promise<SemanticInterpretation> {
  return async (input) => {
    const context = input.context ?? EMPTY_CONTEXT;
    const raw = await model({
      system: SEMANTIC_SYSTEM_PROMPT,
      user: modelUserPayload(input, context),
    });
    const semantic = SemanticTurnSchema.parse(raw);
    if (semantic.turnId !== input.turnId) {
      throw new Error("Semantic model changed turnId");
    }
    if (semantic.originalText !== input.message.trim()) {
      throw new Error("Semantic model changed originalText");
    }
    const grounding = groundSemanticTurn(semantic, context);
    const effectiveTemporal =
      semantic.temporal.specs.length > 0
        ? semantic.temporal.specs
        : semantic.temporal.inherit === "active"
          ? context.activeTemporal
          : [];
    const compiledTemporal = compileTemporalSpecs(effectiveTemporal, {
      now: input.now,
      calendar: input.calendar,
    });
    return {
      semantic,
      grounding,
      compiledTemporal,
      standaloneQuery: rewriteContextualQuery(
        semantic,
        grounding,
        context,
        compiledTemporal
      ),
    };
  };
}

export const interpretSemanticTurn = createSemanticInterpreter();

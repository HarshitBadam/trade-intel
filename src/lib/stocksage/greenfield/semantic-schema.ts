import { z } from "zod";

const ConfidenceSchema = z.number().finite().min(0).max(1);
const IdentifierSchema = z.string().trim().min(1).max(120);
const ShortTextSchema = z.string().trim().min(1).max(240);
function nullableOptional<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .nullable()
    .optional()
    .transform((value): z.output<T> | undefined => value ?? undefined);
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISODateSchema = z
  .string()
  .regex(ISO_DATE)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: "Invalid calendar date" }
  );

export const SemanticIntentSchema = z.enum([
  "social",
  "capability",
  "entity_snapshot",
  "entity_comparison",
  "metric_lookup",
  "causal_analysis",
  "concept_explanation",
  "outlook_research",
  "correction",
  "clarification",
  "high_stakes_finance",
  "prohibited",
  "safety_support",
  "out_of_scope",
]);

export const InformationNeedSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "definition",
      "current_state",
      "price_performance",
      "fundamentals",
      "valuation",
      "risk",
      "catalyst",
      "cause",
      "ranking",
      "comparison",
      "listing_status",
      "source_check",
    ]),
    question: ShortTextSchema,
    priority: z.enum(["primary", "supporting"]),
  })
  .strict();

export const EntityMentionSchema = z
  .object({
    mentionId: IdentifierSchema,
    surface: z.string().trim().min(1).max(160),
    canonicalName: nullableOptional(z.string().trim().min(1).max(160)),
    ticker: nullableOptional(z.string().trim().min(1).max(16)),
    listing: nullableOptional(z.string().trim().min(1).max(40)),
    reference: z.enum([
      "explicit",
      "pronoun",
      "ordered",
      "category",
      "group_member",
    ]),
    role: z.enum(["primary", "comparison", "excluded", "replacement"]),
    issuerOrInstrument: z.enum(["issuer", "instrument", "unknown"]),
    confidence: ConfidenceSchema,
  })
  .strict();

export const EntityInheritanceSchema = z
  .object({
    mode: z.enum([
      "none",
      "singular",
      "plural",
      "ordered",
      "group",
      "all_active",
    ]),
    sourceTurnId: nullableOptional(IdentifierSchema),
    entityIds: z.array(IdentifierSchema).max(12),
    orderedPositions: z
      .array(z.enum(["former", "latter", "first", "second"]))
      .max(4),
    groupId: nullableOptional(IdentifierSchema),
    confidence: ConfidenceSchema,
  })
  .strict();

export const GroupCandidateSchema = z
  .object({
    mention: z.string().trim().min(1).max(160),
    candidateIds: z.array(IdentifierSchema).min(1).max(6),
    selectedId: nullableOptional(IdentifierSchema),
    confidence: ConfidenceSchema,
    reason: ShortTextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selectedId && !value.candidateIds.includes(value.selectedId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedId"],
        message: "selectedId must be one of candidateIds",
      });
    }
  });

export const EntityScopeSchema = z
  .object({
    mentions: z.array(EntityMentionSchema).max(16),
    inheritance: EntityInheritanceSchema,
    groupCandidates: z.array(GroupCandidateSchema).max(6),
    confidence: ConfidenceSchema,
  })
  .strict();

export const ComparisonFrameSchema = z
  .object({
    kind: z.enum([
      "none",
      "entity_vs_entity",
      "time_vs_time",
      "entity_and_time",
    ]),
    entityMentionIds: z.array(IdentifierSchema).max(16),
    temporalSpecIds: z.array(IdentifierSchema).max(8),
    confidence: ConfidenceSchema,
  })
  .strict();

export const MetricSpecSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().trim().min(1).max(80),
    operation: z.enum([
      "level",
      "absolute_change",
      "percentage_change",
      "growth",
      "ratio",
      "rank",
      "qualitative",
    ]),
    unit: nullableOptional(z.string().trim().min(1).max(40)),
    confidence: ConfidenceSchema,
  })
  .strict();

const TemporalSourceSchema = z.enum(["explicit", "inherited", "default"]);

export const AbsoluteTemporalValueSchema = z
  .object({
    type: z.literal("absolute"),
    date: ISODateSchema,
  })
  .strict();

export const RelativeTemporalOffsetSchema = z
  .object({
    type: z.literal("relative"),
    unit: z.enum(["day", "week", "month", "year"]),
    amount: z.number().int().min(0).max(100),
    direction: z.enum(["past", "future"]),
  })
  .strict();

export const TemporalValueSchema = z.union([
  AbsoluteTemporalValueSchema,
  RelativeTemporalOffsetSchema,
]);

export const TemporalPointAnchorSchema = z
  .object({
    kind: z.literal("point"),
    label: z.string().trim().min(1).max(100),
    value: TemporalValueSchema,
  })
  .strict();

export const TemporalRangeAnchorSchema = z
  .object({
    kind: z.literal("range"),
    label: z.string().trim().min(1).max(100),
    start: TemporalValueSchema,
    end: TemporalValueSchema,
    assumptionId: nullableOptional(IdentifierSchema),
  })
  .strict();

export const TemporalAnchorSchema = z.union([
  TemporalPointAnchorSchema,
  TemporalRangeAnchorSchema,
]);

export const TemporalPointSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("point"),
    label: z.string().trim().min(1).max(100),
    value: TemporalValueSchema,
    source: TemporalSourceSchema,
    confidence: ConfidenceSchema,
  })
  .strict();

export const TemporalRangeSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("range"),
    label: z.string().trim().min(1).max(100),
    start: TemporalValueSchema,
    end: TemporalValueSchema,
    assumptionId: nullableOptional(IdentifierSchema),
    source: TemporalSourceSchema,
    confidence: ConfidenceSchema,
  })
  .strict();

export const TemporalComparisonSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.literal("comparison"),
    label: z.string().trim().min(1).max(140),
    left: TemporalAnchorSchema,
    right: TemporalAnchorSchema,
    source: TemporalSourceSchema,
    confidence: ConfidenceSchema,
  })
  .strict();

export const TemporalSpecSchema = z.union([
  TemporalPointSchema,
  TemporalRangeSchema,
  TemporalComparisonSchema,
]);

export const AnswerPreferenceSchema = z
  .object({
    depth: z.enum(["brief", "standard", "deep"]),
    format: z.enum([
      "prose",
      "bullets",
      "table",
      "timeline",
      "side_by_side",
    ]),
    confidence: ConfidenceSchema,
  })
  .strict();

export const SemanticAmbiguitySchema = z
  .object({
    id: IdentifierSchema,
    field: z.enum([
      "intent",
      "entity",
      "group",
      "metric",
      "temporal",
      "comparison",
      "answer",
    ]),
    reason: ShortTextSchema,
    candidates: z.array(z.string().trim().min(1).max(160)).max(8),
    requiresClarification: z.boolean(),
    confidence: ConfidenceSchema,
  })
  .strict();

export const SemanticAssumptionSchema = z
  .object({
    id: IdentifierSchema,
    field: z.enum([
      "intent",
      "entity",
      "group",
      "metric",
      "temporal",
      "comparison",
      "answer",
    ]),
    value: z.string().trim().min(1).max(200),
    reason: ShortTextSchema,
    confidence: ConfidenceSchema,
  })
  .strict();

export const SemanticCorrectionSchema = z
  .object({
    id: IdentifierSchema,
    field: z.enum([
      "entity",
      "group",
      "metric",
      "temporal",
      "information_need",
      "topic",
      "answer",
    ]),
    operation: z.enum(["add", "remove", "replace", "reset", "clarify"]),
    targetId: nullableOptional(IdentifierSchema),
    replacementId: nullableOptional(IdentifierSchema),
    value: nullableOptional(z.string().trim().min(1).max(200)),
    confidence: ConfidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["remove", "replace", "clarify"].includes(value.operation) &&
      !value.targetId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: `${value.operation} requires targetId`,
      });
    }
    if (value.operation === "replace" && !value.replacementId && !value.value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacementId"],
        message: "replace requires replacementId or value",
      });
    }
  });

export const TopicInstructionSchema = z
  .object({
    mode: z.enum(["continue", "pivot", "reset"]),
    label: nullableOptional(z.string().trim().min(1).max(120)),
    confidence: ConfidenceSchema,
  })
  .strict();

export const SemanticTurnSchema = z
  .object({
    version: z.literal(1),
    turnId: IdentifierSchema,
    originalText: z.string().trim().min(1).max(1200),
    intent: z
      .object({
        kind: SemanticIntentSchema,
        confidence: ConfidenceSchema,
      })
      .strict(),
    informationNeeds: z.array(InformationNeedSchema).max(12),
    entities: EntityScopeSchema,
    comparison: ComparisonFrameSchema,
    metrics: z.array(MetricSpecSchema).max(12),
    temporal: z
      .object({
        inherit: z.enum(["none", "active"]),
        specs: z.array(TemporalSpecSchema).max(8),
        confidence: ConfidenceSchema,
      })
      .strict(),
    answer: AnswerPreferenceSchema,
    topic: TopicInstructionSchema,
    ambiguities: z.array(SemanticAmbiguitySchema).max(12),
    assumptions: z.array(SemanticAssumptionSchema).max(12),
    corrections: z.array(SemanticCorrectionSchema).max(12),
    confidence: ConfidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const mentionIds = new Set(value.entities.mentions.map((item) => item.mentionId));
    for (const id of value.comparison.entityMentionIds) {
      if (!mentionIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparison", "entityMentionIds"],
          message: `Unknown entity mention id: ${id}`,
        });
      }
    }

    const temporalIds = new Set(value.temporal.specs.map((item) => item.id));
    for (const id of value.comparison.temporalSpecIds) {
      if (!temporalIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparison", "temporalSpecIds"],
          message: `Unknown temporal spec id: ${id}`,
        });
      }
    }

    const needsEntityComparison =
      value.comparison.kind === "entity_vs_entity" ||
      value.comparison.kind === "entity_and_time";
    const inheritedComparison =
      ["plural", "ordered", "all_active"].includes(
        value.entities.inheritance.mode
      ) &&
      value.entities.inheritance.entityIds.length >= 2;
    const inheritedGroupComparison =
      value.entities.inheritance.mode === "group" &&
      Boolean(value.entities.inheritance.groupId);
    if (
      needsEntityComparison &&
      value.comparison.entityMentionIds.length < 2 &&
      !inheritedComparison &&
      !inheritedGroupComparison
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparison", "entityMentionIds"],
        message: "Entity comparison requires at least two entity mentions",
      });
    }

    const needsTimeComparison =
      value.comparison.kind === "time_vs_time" ||
      value.comparison.kind === "entity_and_time";
    if (needsTimeComparison && value.comparison.temporalSpecIds.length < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparison", "temporalSpecIds"],
        message: "Time comparison requires a temporal comparison specification",
      });
    }

    const assumptionIds = new Set(value.assumptions.map((item) => item.id));
    const linkedAssumptions = value.temporal.specs.flatMap((spec) => {
      if (spec.kind === "range") return spec.assumptionId ? [spec.assumptionId] : [];
      if (spec.kind !== "comparison") return [];
      return [spec.left, spec.right].flatMap((anchor) =>
        anchor.kind === "range" && anchor.assumptionId
          ? [anchor.assumptionId]
          : []
      );
    });
    for (const id of linkedAssumptions) {
      if (!assumptionIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temporal", "specs"],
          message: `Unknown temporal assumption id: ${id}`,
        });
      }
    }
  });

export type SemanticIntent = z.infer<typeof SemanticIntentSchema>;
export type InformationNeed = z.infer<typeof InformationNeedSchema>;
export type EntityMention = z.infer<typeof EntityMentionSchema>;
export type EntityInheritance = z.infer<typeof EntityInheritanceSchema>;
export type GroupCandidate = z.infer<typeof GroupCandidateSchema>;
export type ComparisonFrame = z.infer<typeof ComparisonFrameSchema>;
export type MetricSpec = z.infer<typeof MetricSpecSchema>;
export type TemporalValue = z.infer<typeof TemporalValueSchema>;
export type RelativeTemporalOffset = z.infer<
  typeof RelativeTemporalOffsetSchema
>;
export type TemporalAnchor = z.infer<typeof TemporalAnchorSchema>;
export type TemporalSpec = z.infer<typeof TemporalSpecSchema>;
export type AnswerPreference = z.infer<typeof AnswerPreferenceSchema>;
export type SemanticAmbiguity = z.infer<typeof SemanticAmbiguitySchema>;
export type SemanticAssumption = z.infer<typeof SemanticAssumptionSchema>;
export type SemanticCorrection = z.infer<typeof SemanticCorrectionSchema>;
export type SemanticTurn = z.infer<typeof SemanticTurnSchema>;

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  SemanticIntentSchema,
  SemanticTurnSchema,
  type SemanticTurn,
} from "./semantic-schema";

const NeedKindSchema = z.enum([
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
]);

const FieldSchema = z.enum([
  "intent",
  "entity",
  "group",
  "metric",
  "temporal",
  "comparison",
  "answer",
]);

function nullableOptional<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .nullable()
    .optional()
    .transform((value): z.output<T> | undefined => value ?? undefined);
}

const TemporalValueWireSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("absolute"),
      date: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relative"),
      unit: z.enum(["day", "week", "month", "year"]),
      amount: z.number().int().min(0).max(100),
      direction: z.enum(["past", "future"]),
    })
    .strict(),
]);

const PointAnchorWireSchema = z
  .object({
    kind: z.literal("point"),
    label: z.string(),
    value: TemporalValueWireSchema,
  })
  .strict();

const RangeAnchorWireSchema = z
  .object({
    kind: z.literal("range"),
    label: z.string(),
    start: TemporalValueWireSchema,
    end: TemporalValueWireSchema,
    assumptionKey: nullableOptional(z.string()),
  })
  .strict();

const TemporalAnchorWireSchema = z.discriminatedUnion("kind", [
  PointAnchorWireSchema,
  RangeAnchorWireSchema,
]);

const TemporalSpecWireSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("point"),
      label: z.string(),
      value: TemporalValueWireSchema,
      source: z.enum(["explicit", "inherited", "default"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("range"),
      label: z.string(),
      start: TemporalValueWireSchema,
      end: TemporalValueWireSchema,
      assumptionKey: nullableOptional(z.string()),
      source: z.enum(["explicit", "inherited", "default"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      label: z.string(),
      left: TemporalAnchorWireSchema,
      right: TemporalAnchorWireSchema,
      source: z.enum(["explicit", "inherited", "default"]),
    })
    .strict(),
]);

export const SemanticExtractionWireSchema = z
  .object({
    intent: SemanticIntentSchema,
    needs: z.array(NeedKindSchema).max(12),
    entities: z
      .object({
        mentions: z
          .array(
            z
              .object({
                surface: z.string(),
                canonicalName: nullableOptional(z.string()),
                ticker: nullableOptional(z.string()),
                listing: nullableOptional(z.string()),
                reference: z.enum([
                  "explicit",
                  "pronoun",
                  "ordered",
                  "category",
                  "group_member",
                ]),
                role: z.enum([
                  "primary",
                  "comparison",
                  "excluded",
                  "replacement",
                ]),
                issuerOrInstrument: z.enum([
                  "issuer",
                  "instrument",
                  "unknown",
                ]),
              })
              .strict()
          )
          .max(16),
        inheritance: z
          .object({
            mode: z.enum([
              "none",
              "singular",
              "plural",
              "ordered",
              "group",
              "all_active",
            ]),
            sourceTurnId: nullableOptional(z.string()),
            entityIds: z.array(z.string()).max(12),
            orderedPositions: z
              .array(z.enum(["former", "latter", "first", "second"]))
              .max(4),
            groupId: nullableOptional(z.string()),
          })
          .strict(),
        groupCandidates: z
          .array(
            z
              .object({
                mention: z.string(),
                candidateIds: z.array(z.string()).max(6),
                selectedId: nullableOptional(z.string()),
                reason: z.string(),
              })
              .strict()
          )
          .max(6),
      })
      .strict(),
    comparison: z.enum([
      "none",
      "entity_vs_entity",
      "time_vs_time",
      "entity_and_time",
    ]),
    metrics: z
      .array(
        z
          .object({
            name: z.string(),
            operation: z.enum([
              "level",
              "absolute_change",
              "percentage_change",
              "growth",
              "ratio",
              "rank",
              "qualitative",
            ]),
            unit: nullableOptional(z.string()),
          })
          .strict()
      )
      .max(12),
    temporal: z
      .object({
        inherit: z.enum(["none", "active"]),
        specs: z.array(TemporalSpecWireSchema).max(8),
      })
      .strict(),
    answer: z
      .object({
        depth: z.enum(["brief", "standard", "deep"]),
        format: z.enum([
          "prose",
          "bullets",
          "table",
          "timeline",
          "side_by_side",
        ]),
      })
      .strict(),
    topic: z
      .object({
        mode: z.enum(["continue", "pivot", "reset"]),
        label: nullableOptional(z.string()),
      })
      .strict(),
    ambiguities: z
      .array(
        z
          .object({
            field: FieldSchema,
            reason: z.string(),
            candidates: z.array(z.string()).max(8),
            requiresClarification: z.boolean(),
          })
          .strict()
      )
      .max(12),
    assumptions: z
      .array(
        z
          .object({
            key: z.string(),
            field: FieldSchema,
            value: z.string(),
            reason: z.string(),
          })
          .strict()
      )
      .max(12),
    corrections: z
      .array(
        z
          .object({
            field: z.enum([
              "entity",
              "group",
              "metric",
              "temporal",
              "information_need",
              "topic",
              "answer",
            ]),
            operation: z.enum([
              "add",
              "remove",
              "replace",
              "reset",
              "clarify",
            ]),
            targetId: nullableOptional(z.string()),
            replacementId: nullableOptional(z.string()),
            value: nullableOptional(z.string()),
          })
          .strict()
      )
      .max(12),
  })
  .strict();

export const SEMANTIC_EXTRACTION_JSON_SCHEMA = zodToJsonSchema(
  SemanticExtractionWireSchema,
  {
    target: "openAi",
    $refStrategy: "root",
  }
) as Record<string, unknown>;

export type SemanticExtractionWire = z.infer<
  typeof SemanticExtractionWireSchema
>;

function confidence(): number {
  return 0.85;
}

function clip(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return normalized.slice(0, maximum).trimEnd();
}

function temporalAnchor(
  item: z.infer<typeof TemporalAnchorWireSchema>
) {
  if (item.kind === "point") return item;
  return {
    kind: item.kind,
    label: item.label,
    start: item.start,
    end: item.end,
    ...(item.assumptionKey ? { assumptionId: item.assumptionKey } : {}),
  };
}

function temporalSpec(
  item: SemanticExtractionWire["temporal"]["specs"][number],
  index: number
) {
  const common = {
    id: `time-${index + 1}`,
    label: item.label,
    source: item.source,
    confidence: confidence(),
  };
  if (item.kind === "point") return { ...common, kind: item.kind, value: item.value };
  if (item.kind === "range") {
    return {
      ...common,
      kind: item.kind,
      start: item.start,
      end: item.end,
      ...(item.assumptionKey ? { assumptionId: item.assumptionKey } : {}),
    };
  }
  return {
    ...common,
    kind: item.kind,
    left: temporalAnchor(item.left),
    right: temporalAnchor(item.right),
  };
}

export function expandSemanticExtraction(args: {
  raw: unknown;
  turnId: string;
  originalText: string;
}): SemanticTurn {
  const wire = SemanticExtractionWireSchema.parse(args.raw);
  const mentions = wire.entities.mentions.map((mention, index) => ({
    mentionId: `entity-${index + 1}`,
    ...mention,
    surface: clip(mention.surface, 160),
    ...(mention.canonicalName
      ? { canonicalName: clip(mention.canonicalName, 160) }
      : {}),
    ...(mention.ticker ? { ticker: clip(mention.ticker, 16) } : {}),
    ...(mention.listing ? { listing: clip(mention.listing, 40) } : {}),
    confidence: confidence(),
  }));
  const specs = wire.temporal.specs.map(temporalSpec);
  const assumptions = wire.assumptions.map((assumption, index) => ({
    id: assumption.key || `assumption-${index + 1}`,
    field: assumption.field,
    value: clip(assumption.value, 200),
    reason: clip(assumption.reason, 240),
    confidence: confidence(),
  }));
  const knownAssumptions = new Set(assumptions.map((item) => item.id));
  for (const spec of specs) {
    const keys =
      spec.kind === "range"
        ? spec.assumptionId
          ? [spec.assumptionId]
          : []
        : spec.kind === "comparison"
          ? [spec.left, spec.right].flatMap((anchor) =>
              anchor.kind === "range" && anchor.assumptionId
                ? [anchor.assumptionId]
                : []
            )
          : [];
    for (const key of keys) {
      if (knownAssumptions.has(key)) continue;
      assumptions.push({
        id: key,
        field: "temporal",
        value: key,
        reason: "The temporal phrase required an explicit reversible assumption.",
        confidence: confidence(),
      });
      knownAssumptions.add(key);
    }
  }
  const temporalIds = specs.map((item) => item.id);
  const entityIds = mentions
    .filter((mention) => mention.role !== "excluded")
    .map((mention) => mention.mentionId);
  return SemanticTurnSchema.parse({
    version: 1,
    turnId: args.turnId,
    originalText: args.originalText,
    intent: { kind: wire.intent, confidence: confidence() },
    informationNeeds: wire.needs.map((kind, index) => ({
      id: `need-${index + 1}`,
      kind,
      question: `${kind.replaceAll("_", " ")} evidence`,
      priority: index === 0 ? "primary" : "supporting",
    })),
    entities: {
      mentions,
      inheritance: {
        ...wire.entities.inheritance,
        confidence: confidence(),
      },
      groupCandidates: wire.entities.groupCandidates.map((candidate) => ({
        ...candidate,
        mention: clip(candidate.mention, 160),
        reason: clip(candidate.reason, 240),
        confidence: confidence(),
      })),
      confidence: confidence(),
    },
    comparison: {
      kind: wire.comparison,
      entityMentionIds:
        wire.comparison === "entity_vs_entity" ||
        wire.comparison === "entity_and_time"
          ? entityIds
          : [],
      temporalSpecIds:
        wire.comparison === "time_vs_time" ||
        wire.comparison === "entity_and_time"
          ? temporalIds
          : [],
      confidence: confidence(),
    },
    metrics: wire.metrics.map((metric, index) => ({
      id: `metric-${index + 1}`,
      ...metric,
      name: clip(metric.name, 80),
      ...(metric.unit ? { unit: clip(metric.unit, 40) } : {}),
      confidence: confidence(),
    })),
    temporal: {
      inherit: wire.temporal.inherit,
      specs,
      confidence: confidence(),
    },
    answer: { ...wire.answer, confidence: confidence() },
    topic: {
      ...wire.topic,
      ...(wire.topic.label ? { label: clip(wire.topic.label, 120) } : {}),
      confidence: confidence(),
    },
    ambiguities: wire.ambiguities.map((ambiguity, index) => ({
      id: `ambiguity-${index + 1}`,
      ...ambiguity,
      reason: clip(ambiguity.reason, 240),
      candidates: ambiguity.candidates.map((candidate) =>
        clip(candidate, 160)
      ),
      confidence: confidence(),
    })),
    assumptions,
    corrections: wire.corrections.map((correction, index) => ({
      id: `correction-${index + 1}`,
      ...correction,
      ...(correction.value ? { value: clip(correction.value, 200) } : {}),
      confidence: confidence(),
    })),
    confidence: confidence(),
  });
}

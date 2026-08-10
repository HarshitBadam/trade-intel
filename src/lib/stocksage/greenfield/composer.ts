import { GROQ_ANALYSIS_MODEL, GROQ_FALLBACK_MODEL } from "@/lib/config";
import { groqChatJSON, groqErrorSummary } from "@/lib/groq";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ComposerDraft,
  ComposerInput,
  ComposerModel,
} from "./answering";

function nullableOptional<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .nullable()
    .optional()
    .transform((value): z.output<T> | undefined => value ?? undefined);
}

const FactReferenceSchema = z
  .object({
    evidenceId: z.string().min(1).max(160),
    factKey: z.string().min(1).max(160),
  })
  .strict();

const CalculationSchema = z
  .object({
    operation: z.enum([
      "sum",
      "difference",
      "product",
      "ratio",
      "average",
      "minimum",
      "maximum",
      "percent_change",
    ]),
    operands: z.array(FactReferenceSchema).min(1).max(12),
    result: z.number().finite(),
    tolerance: nullableOptional(z.number().finite().nonnegative()),
  })
  .strict();

const ClaimSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(1_200),
    kind: nullableOptional(
      z.enum(["factual", "derived", "inference", "opinion"])
    ),
    evidenceIds: nullableOptional(
      z.array(z.string().min(1).max(160)).max(12)
    ),
    factRefs: nullableOptional(z.array(FactReferenceSchema).max(12)),
    supportKey: nullableOptional(z.string().min(1).max(160)),
    calculation: nullableOptional(CalculationSchema),
    instrument: nullableOptional(z.string().min(1).max(80)),
    currency: nullableOptional(z.string().min(1).max(16)),
    periodStart: nullableOptional(
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    ),
    periodEnd: nullableOptional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  })
  .strict();

const ComposerDraftSchema = z
  .object({
    claims: z.array(ClaimSchema).max(24),
  })
  .strict();

const COMPOSER_JSON_SCHEMA = zodToJsonSchema(ComposerDraftSchema, {
  target: "openAi",
  $refStrategy: "none",
}) as Record<string, unknown>;

const SYSTEM = `You are StockSage's grounded answer composer.
Return one JSON object with exactly one top-level "claims" array. Do not return
prose outside JSON. Each claim has id, text, kind, and claim-level
evidenceIds. Derived numbers must also include factRefs and a calculation whose
result is exactly reproducible from the supplied facts. Never cite an evidence
ID or fact key that is absent. Every non-derived factual claim must include
either exact factRefs or one supportKey copied verbatim from the cited evidence.
Do not use evidence available after the requested as-of time. Keep issuer and
traded instrument, currency, and period identities distinct. Treat causal
language as an inference unless a cited source directly states the causal link.
Unsupported claims should be omitted, not guessed.
Answer depth controls scope: glance is one direct claim, standard includes a
conclusion plus key evidence and caveats, detailed/deep covers the thesis,
counter-evidence, risks, and what matters next.

Every claim property required by the response schema must be present. Emit null
for inapplicable optional scalar or object fields and an empty array when there
are no evidence IDs or fact references.`;

export type StructuredComposerJsonModel = (args: {
  system: string;
  user: string;
}) => Promise<unknown>;

export const groqStructuredComposerModel: StructuredComposerJsonModel = async (
  args
) => {
  const complete = (model: string) =>
    groqChatJSON({
      model,
      system: args.system,
      user: args.user,
      temperature: 0.1,
      maxTokens: 2_400,
      jsonSchema: {
        name: "composer_draft",
        schema: COMPOSER_JSON_SCHEMA,
        strict: true,
      },
    });
  try {
    return await complete(GROQ_ANALYSIS_MODEL);
  } catch (error) {
    const summary = groqErrorSummary(error);
    if (
      GROQ_FALLBACK_MODEL === GROQ_ANALYSIS_MODEL ||
      (summary.status !== 429 &&
        (summary.status === undefined || summary.status < 500))
    ) {
      throw error;
    }
    return complete(GROQ_FALLBACK_MODEL);
  }
};

function evidencePayload(input: ComposerInput): unknown[] {
  return input.evidence.map((item) => ({
    id: item.id,
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    title: item.title,
    excerpt: item.excerpt,
    observedAt: item.observedAt,
    availableAt: item.availableAt,
    instrument: item.instrument,
    currency: item.currency,
    periodStart: item.periodStart,
    periodEnd: item.periodEnd,
    supports: item.supports,
    facts: item.facts,
  }));
}

export function createStructuredComposer(
  model: StructuredComposerJsonModel = groqStructuredComposerModel
): ComposerModel {
  return {
    async compose(input): Promise<ComposerDraft> {
      const raw = await model({
        system: SYSTEM,
        user: JSON.stringify({
          question: input.question,
          depth: input.depth,
          allowedEvidenceIds: input.evidenceIds,
          evidence: evidencePayload(input),
          publicationInstructions: input.instructions,
        }),
      });
      return ComposerDraftSchema.parse(raw);
    },
  };
}

export const defaultStructuredComposer = createStructuredComposer();

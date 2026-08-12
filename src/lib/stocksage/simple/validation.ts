import { z } from "zod";
import type { SimpleEvidencePlan } from "./contracts";

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Invalid calendar date");

export const PricePairsSchema = z
  .array(z.tuple([z.string().trim().min(1).max(100), IsoDateSchema]))
  .max(24);

const SimpleEvidencePlanSchema = z.object({
  prices: PricePairsSchema.optional().default([]),
  news: z.array(z.string().trim().min(1).max(500)).max(3).optional().default([]),
  rankings: z
    .array(
      z.tuple([z.enum(["US", "ASX", "UNSPECIFIED"]), IsoDateSchema])
    )
    .max(2)
    .optional()
    .default([]),
});

export function normalizeSimpleEvidencePlan(raw: unknown): SimpleEvidencePlan {
  const parsed = SimpleEvidencePlanSchema.parse(raw);
  return {
    prices: parsed.prices,
    news: parsed.news,
    rankings: parsed.rankings,
  };
}

export function hasSimpleEvidenceRequest(
  plan: SimpleEvidencePlan
): boolean {
  return (
    plan.prices.length > 0 ||
    plan.news.length > 0 ||
    plan.rankings.length > 0
  );
}

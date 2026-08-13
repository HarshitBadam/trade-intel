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

export const RankingMarketSchema = z.enum(["US", "ASX", "UNSPECIFIED"]);

export const SubjectDatePairSchema = z.tuple([
  z.string().trim().min(1).max(100),
  IsoDateSchema,
]);

export const NewsQuerySchema = z.string().trim().min(1).max(500);

export const RankingTupleSchema = z.tuple([RankingMarketSchema, IsoDateSchema]);

export const PricePairsSchema = z.array(SubjectDatePairSchema).max(24);

const SimpleEvidencePlanSchema = z.object({
  prices: PricePairsSchema.optional().default([]),
  news: z.array(NewsQuerySchema).max(3).optional().default([]),
  rankings: z.array(RankingTupleSchema).max(2).optional().default([]),
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

export function summarizeZodIssues(error: z.ZodError): {
  issuePaths: string[];
  issueCount: number;
} {
  const issuePaths = [
    ...new Set(
      error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)"))
    ),
  ].slice(0, 10);
  return { issuePaths, issueCount: error.issues.length };
}

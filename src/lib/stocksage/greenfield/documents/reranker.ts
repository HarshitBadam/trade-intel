import { tokenizeDocumentText } from "./bm25";
import type { Reranker } from "./ports";
import {
  documentIdentity,
  documentText,
  type FusedRetrievalHit,
  type NormalizedDocument,
} from "./types";

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function overlap(
  queryTerms: ReadonlySet<string>,
  text: string
): number {
  if (queryTerms.size === 0) return 0;
  const terms = new Set(tokenizeDocumentText(text));
  let matches = 0;
  for (const term of queryTerms) if (terms.has(term)) matches += 1;
  return matches / queryTerms.size;
}

function parsedTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function primarySourceScore(document: NormalizedDocument): number {
  if (document.kind === "filing" || document.kind === "press_release") return 1;
  if (
    document.metadata?.primarySource === true ||
    document.metadata?.isPrimarySource === true ||
    document.provenance.metadata?.primarySource === true ||
    document.provenance.metadata?.isPrimarySource === true
  ) {
    return 1;
  }
  if (document.kind === "transcript") return 0.75;
  if (
    document.provenance.upstreamIds &&
    Object.keys(document.provenance.upstreamIds).length > 0 &&
    (document.provenance.authorityScore ?? 0) >= 0.9
  ) {
    return 0.5;
  }
  return 0;
}

function noisePenalty(document: NormalizedDocument): number {
  const title = document.title;
  const text = `${title} ${documentText(document).slice(0, 1_000)}`;
  let penalty = 0;

  if (
    /\b(?:top\s+\d+|best\s+\w+\s+stocks?\s+to\s+buy|price\s+prediction|stock\s+forecast|must[- ]read|click\s+here|what\s+you\s+need\s+to\s+know|everything\s+you\s+need\s+to\s+know)\b/i.test(
      title
    )
  ) {
    penalty += 0.15;
  }
  if (
    /\b(?:posted\s+by|join\s+the\s+discussion|upvotes?|retweets?|followers?|subscribe\s+to|sign\s+up\s+for|share\s+on)\b/i.test(
      text
    )
  ) {
    penalty += 0.12;
  }
  try {
    const path = new URL(
      document.provenance.canonicalUrl ?? document.provenance.sourceUrl
    ).pathname;
    if (
      /\/(?:search|tags?|categories|forums?|community|discussions?)(?:\/|$)/i.test(
        path
      )
    ) {
      penalty += 0.06;
    }
  } catch {
    // Invalid source URLs are rejected by document validation.
  }
  const letters = title.match(/\p{L}/gu) ?? [];
  const uppercase = title.match(/\p{Lu}/gu) ?? [];
  if (letters.length >= 12 && uppercase.length / letters.length >= 0.7) {
    penalty += 0.05;
  }
  if ((title.match(/!/g) ?? []).length >= 2) penalty += 0.04;

  return clamp(penalty, 0, 0.25);
}

/**
 * Deterministic reranker for the no-provider reference path. External
 * cross-encoders can replace it through the Reranker port.
 */
export class HeuristicReranker implements Reranker {
  rerank(
    query: string,
    hits: readonly FusedRetrievalHit[],
    limit: number
  ): readonly FusedRetrievalHit[] {
    if (hits.length === 0 || limit <= 0) return [];
    const queryTerms = new Set(tokenizeDocumentText(query));
    const maximumFused = Math.max(...hits.map((hit) => hit.fusedScore), 1e-12);
    const referenceTimes = hits.flatMap((hit) =>
      [hit.document.fetchedAt, hit.document.publishedAt].flatMap((value) => {
        const parsed = parsedTimestamp(value);
        return parsed === undefined ? [] : [parsed];
      })
    );
    const referenceTime =
      referenceTimes.length > 0 ? Math.max(...referenceTimes) : 0;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    return hits
      .map((hit) => {
        const titleOverlap = overlap(queryTerms, hit.document.title);
        const contentOverlap = overlap(
          queryTerms,
          documentText(hit.document)
        );
        const authority = clamp(
          hit.document.provenance.authorityScore ?? 0.5
        );
        const publishedAt = parsedTimestamp(hit.document.publishedAt);
        const publicationAge =
          publishedAt === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, referenceTime - publishedAt);
        const freshness =
          publishedAt === undefined
            ? 0
            : clamp(1 - publicationAge / ninetyDays);
        const entityConfirmed =
          hit.document.issuerIds.length > 0 ||
          hit.document.instrumentIds.length > 0
            ? 1
            : 0;
        const rerankerScore = clamp(
          0.4 * (hit.fusedScore / maximumFused) +
            0.16 * contentOverlap +
            0.12 * titleOverlap +
            0.08 * authority +
            0.08 * freshness +
            0.1 * primarySourceScore(hit.document) +
            0.06 * entityConfirmed -
            noisePenalty(hit.document)
        );
        return { ...hit, rerankerScore };
      })
      .sort(
        (left, right) =>
          (right.rerankerScore ?? 0) - (left.rerankerScore ?? 0) ||
          right.fusedScore - left.fusedScore ||
          documentIdentity(left.document).localeCompare(
            documentIdentity(right.document)
          )
      )
      .slice(0, limit)
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
  }
}

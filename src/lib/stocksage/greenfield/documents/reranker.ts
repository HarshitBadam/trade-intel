import { tokenizeDocumentText } from "./bm25";
import type { Reranker } from "./ports";
import {
  documentIdentity,
  documentText,
  type FusedRetrievalHit,
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
    const newestFetch = Math.max(
      ...hits.map((hit) => Date.parse(hit.document.fetchedAt))
    );
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
        const fetchAge = Math.max(
          0,
          newestFetch - Date.parse(hit.document.fetchedAt)
        );
        const freshness = clamp(1 - fetchAge / ninetyDays);
        const rerankerScore =
          0.55 * (hit.fusedScore / maximumFused) +
          0.2 * contentOverlap +
          0.15 * titleOverlap +
          0.07 * authority +
          0.03 * freshness;
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

import {
  documentIdentity,
  type FusedRetrievalHit,
  type RetrievalChannel,
  type RetrievalHit,
} from "./types";

export type RrfRankedList = {
  channel: RetrievalChannel;
  hits: readonly RetrievalHit[];
  weight?: number;
};

export type RrfOptions = {
  k?: number;
  limit?: number;
  weights?: Partial<Record<RetrievalChannel, number>>;
};

function fusionKey(hit: RetrievalHit): string {
  return `${documentIdentity(hit.document)}::${hit.document.contentVersion}`;
}

function asRankedLists(
  lists: readonly RrfRankedList[] | readonly (readonly RetrievalHit[])[]
): readonly RrfRankedList[] {
  return lists.map((list) => {
    if ("hits" in list) return list;
    return {
      channel: list[0]?.channel ?? "lexical",
      hits: list,
    };
  });
}

/**
 * Reciprocal-rank fusion. Raw scores can come from unrelated scales; only each
 * provider's rank contributes to the fused score.
 */
export function reciprocalRankFusion(
  lists: readonly RrfRankedList[] | readonly (readonly RetrievalHit[])[],
  options: RrfOptions = {}
): FusedRetrievalHit[] {
  const k = Math.max(1, options.k ?? 60);
  const byDocument = new Map<
    string,
    {
      representative: RetrievalHit;
      fusedScore: number;
      channels: Set<RetrievalChannel>;
      componentScores: Partial<Record<RetrievalChannel, number>>;
    }
  >();

  for (const list of asRankedLists(lists)) {
    const weight =
      list.weight ?? options.weights?.[list.channel] ?? 1;
    if (weight <= 0) continue;
    const seenInList = new Set<string>();
    list.hits.forEach((hit, index) => {
      const key = fusionKey(hit);
      if (seenInList.has(key)) return;
      seenInList.add(key);
      const existing = byDocument.get(key);
      const contribution = weight / (k + index + 1);
      if (!existing) {
        byDocument.set(key, {
          representative: hit,
          fusedScore: contribution,
          channels: new Set([list.channel]),
          componentScores: { [list.channel]: hit.score },
        });
        return;
      }
      existing.fusedScore += contribution;
      existing.channels.add(list.channel);
      existing.componentScores[list.channel] = Math.max(
        existing.componentScores[list.channel] ?? Number.NEGATIVE_INFINITY,
        hit.score
      );
      if ((hit.rank ?? index + 1) < (existing.representative.rank ?? Infinity)) {
        existing.representative = hit;
      }
    });
  }

  const limit = Math.max(0, options.limit ?? byDocument.size);
  return [...byDocument.values()]
    .map(
      ({
        representative,
        fusedScore,
        channels,
        componentScores,
      }): FusedRetrievalHit => ({
        ...representative,
        score: fusedScore,
        lexicalScore: componentScores.lexical,
        semanticScore: componentScores.semantic,
        liveScore: componentScores.live,
        fusedScore,
        channels: [...channels],
        componentScores: Object.freeze({ ...componentScores }),
      })
    )
    .sort(
      (left, right) =>
        right.fusedScore - left.fusedScore ||
        Date.parse(right.document.fetchedAt) -
          Date.parse(left.document.fetchedAt) ||
        documentIdentity(left.document).localeCompare(
          documentIdentity(right.document)
        )
    )
    .slice(0, limit)
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}

export const fuseRetrievalHits = reciprocalRankFusion;
export const rrfFuse = reciprocalRankFusion;

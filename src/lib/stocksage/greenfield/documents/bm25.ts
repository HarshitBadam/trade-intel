import type { LexicalIndex } from "./ports";
import {
  documentIdentity,
  documentText,
  type NormalizedDocument,
  type RetrievalHit,
} from "./types";

export type Bm25Options = {
  k1?: number;
  b?: number;
  titleBoost?: number;
};

export function tokenizeDocumentText(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 1
  );
}

function termCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * Small-corpus BM25 implementation. It intentionally accepts the corpus per
 * request so callers can keep storage/index providers independently swappable.
 */
export class InMemoryBm25LexicalIndex implements LexicalIndex {
  readonly #k1: number;
  readonly #b: number;
  readonly #titleBoost: number;

  constructor(options: Bm25Options = {}) {
    this.#k1 = options.k1 ?? 1.2;
    this.#b = options.b ?? 0.75;
    this.#titleBoost = Math.max(1, options.titleBoost ?? 2);
  }

  search(
    text: string,
    corpus: readonly NormalizedDocument[],
    limit: number
  ): readonly RetrievalHit[] {
    const queryTerms = termCounts(tokenizeDocumentText(text));
    if (queryTerms.size === 0 || corpus.length === 0 || limit <= 0) return [];

    const indexed = corpus.map((document) => {
      const titleTokens = tokenizeDocumentText(document.title);
      const bodyTokens = tokenizeDocumentText(documentText(document));
      const identityTokens = tokenizeDocumentText(
        [...document.issuerIds, ...document.instrumentIds].join(" ")
      );
      const weightedTitle = Array.from(
        { length: Math.ceil(this.#titleBoost) },
        () => titleTokens
      ).flat();
      const tokens = [...weightedTitle, ...bodyTokens, ...identityTokens];
      return {
        document,
        counts: termCounts(tokens),
        length: Math.max(1, tokens.length),
      };
    });
    const averageLength =
      indexed.reduce((total, item) => total + item.length, 0) / indexed.length;
    const documentFrequency = new Map<string, number>();
    for (const term of queryTerms.keys()) {
      documentFrequency.set(
        term,
        indexed.reduce(
          (total, item) => total + (item.counts.has(term) ? 1 : 0),
          0
        )
      );
    }

    return indexed
      .map(({ document, counts, length }): RetrievalHit => {
        let score = 0;
        for (const [term, queryFrequency] of queryTerms) {
          const frequency = counts.get(term) ?? 0;
          if (frequency === 0) continue;
          const frequencyInCorpus = documentFrequency.get(term) ?? 0;
          const inverseDocumentFrequency = Math.log(
            1 +
              (indexed.length - frequencyInCorpus + 0.5) /
                (frequencyInCorpus + 0.5)
          );
          const normalizedFrequency =
            (frequency * (this.#k1 + 1)) /
            (frequency +
              this.#k1 *
                (1 - this.#b + this.#b * (length / averageLength)));
          score +=
            inverseDocumentFrequency *
            normalizedFrequency *
            (1 + Math.log(queryFrequency));
        }
        return {
          document,
          channel: "lexical",
          provider: "bm25",
          score,
          lexicalScore: score,
        };
      })
      .filter((hit) => hit.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          Date.parse(right.document.fetchedAt) -
            Date.parse(left.document.fetchedAt) ||
          documentIdentity(left.document).localeCompare(
            documentIdentity(right.document)
          )
      )
      .slice(0, limit)
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
  }
}

/** Common capitalization alias. */
export { InMemoryBm25LexicalIndex as InMemoryBM25LexicalIndex };
export { InMemoryBm25LexicalIndex as InMemoryBM25Index };
export { InMemoryBm25LexicalIndex as Bm25LexicalIndex };

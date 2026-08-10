import type {
  DocumentFilter,
  FusedRetrievalHit,
  NormalizedDocument,
  RetrievalHit,
  RetrievalQuery,
} from "./types";

export type MaybePromise<T> = T | Promise<T>;

export type DocumentRetentionPolicy = {
  mode: "long_retention";
  /** `null` means the store does not expire documents by age. */
  retentionDays: number | null;
  automaticExpiration: boolean;
};

export type NonExpiringDocumentRetentionPolicy = DocumentRetentionPolicy & {
  retentionDays: null;
  automaticExpiration: false;
};

export interface DocumentStore {
  readonly retentionPolicy: DocumentRetentionPolicy;
  put(document: NormalizedDocument): MaybePromise<void>;
  putMany(documents: readonly NormalizedDocument[]): MaybePromise<void>;
  get(
    documentId: string,
    contentVersion?: string
  ): MaybePromise<NormalizedDocument | undefined>;
  list(filter?: DocumentFilter): MaybePromise<readonly NormalizedDocument[]>;
}

export interface LongRetentionDocumentStore extends DocumentStore {
  readonly retentionPolicy: NonExpiringDocumentRetentionPolicy;
}

export interface LexicalIndex {
  search(
    text: string,
    corpus: readonly NormalizedDocument[],
    limit: number
  ): MaybePromise<readonly RetrievalHit[]>;
}

export interface SemanticIndex {
  search(
    text: string,
    filter: DocumentFilter,
    limit: number
  ): MaybePromise<readonly RetrievalHit[]>;
}

export interface LiveSearch {
  search(query: RetrievalQuery): MaybePromise<readonly RetrievalHit[]>;
}

/** Backward-friendly alias for adapters that use the provider suffix. */
export type LiveSearchProvider = LiveSearch;

export interface Reranker {
  rerank(
    query: string,
    hits: readonly FusedRetrievalHit[],
    limit: number
  ): MaybePromise<readonly FusedRetrievalHit[]>;
}

export class NoopSemanticIndex implements SemanticIndex {
  search(): readonly RetrievalHit[] {
    return [];
  }
}

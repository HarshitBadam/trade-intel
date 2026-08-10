import { filterDocument, validateNormalizedDocument } from "./filters";
import type {
  LongRetentionDocumentStore,
  MaybePromise,
} from "./ports";
import {
  documentIdentity,
  type DocumentFilter,
  type NormalizedDocument,
} from "./types";

const LONG_RETENTION_POLICY = Object.freeze({
  mode: "long_retention" as const,
  retentionDays: null,
  automaticExpiration: false,
});

export type DurableDocumentRecord = {
  _id: string;
  documentId: string;
  contentVersion: string;
  kind: NormalizedDocument["kind"];
  issuerIds: readonly string[];
  instrumentIds: readonly string[];
  eventAt?: string;
  publishedAt?: string;
  fetchedAt: string;
  currency?: string;
  document: NormalizedDocument;
};

export type DurableDocumentQuery = Readonly<Record<string, unknown>>;

export type DurableDocumentCursor = {
  toArray(): MaybePromise<readonly DurableDocumentRecord[]>;
};

/**
 * Minimal collection surface shared by Astra/Mongo-style durable collections.
 * The backing collection must be configured without a TTL.
 */
export interface DurableDocumentCollection {
  insertOne(record: DurableDocumentRecord): MaybePromise<unknown>;
  findOne(
    filter: DurableDocumentQuery
  ): MaybePromise<DurableDocumentRecord | null | undefined>;
  find(
    filter: DurableDocumentQuery,
    options?: Readonly<Record<string, unknown>>
  ): MaybePromise<readonly DurableDocumentRecord[] | DurableDocumentCursor>;
}

function immutableDocument(
  document: NormalizedDocument
): NormalizedDocument {
  const provenance = Object.freeze({
    ...document.provenance,
    upstreamIds: document.provenance.upstreamIds
      ? Object.freeze({ ...document.provenance.upstreamIds })
      : undefined,
    metadata: document.provenance.metadata
      ? Object.freeze({ ...document.provenance.metadata })
      : undefined,
  });
  return Object.freeze({
    ...document,
    issuerIds: Object.freeze([...document.issuerIds]),
    instrumentIds: Object.freeze([...document.instrumentIds]),
    units: document.units ? Object.freeze([...document.units]) : undefined,
    provenance,
    metadata: document.metadata
      ? Object.freeze({ ...document.metadata })
      : undefined,
  });
}

function newestFirst(
  left: NormalizedDocument,
  right: NormalizedDocument
): number {
  return (
    Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt) ||
    (right.publishedAt ? Date.parse(right.publishedAt) : 0) -
      (left.publishedAt ? Date.parse(left.publishedAt) : 0) ||
    right.contentVersion.localeCompare(left.contentVersion)
  );
}

function recordId(documentId: string, contentVersion: string): string {
  return `${encodeURIComponent(documentId)}::${encodeURIComponent(contentVersion)}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function sameDocument(
  left: NormalizedDocument,
  right: NormalizedDocument
): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function toRecord(document: NormalizedDocument): DurableDocumentRecord {
  const immutable = immutableDocument(document);
  const documentId = documentIdentity(immutable);
  return {
    _id: recordId(documentId, immutable.contentVersion),
    documentId,
    contentVersion: immutable.contentVersion,
    kind: immutable.kind,
    issuerIds: immutable.issuerIds,
    instrumentIds: immutable.instrumentIds,
    eventAt: immutable.eventAt,
    publishedAt: immutable.publishedAt,
    fetchedAt: immutable.fetchedAt,
    currency: immutable.currency,
    document: immutable,
  };
}

function idConstraint(
  values: readonly string[] | undefined,
  match: "any" | "all"
): unknown {
  if (!values?.length) return undefined;
  return match === "all" ? { $all: [...values] } : { $in: [...values] };
}

function rangeConstraint(
  from: string | undefined,
  to: string | undefined
): Readonly<Record<string, string>> | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lte: to } : {}),
  };
}

function durableQuery(filter: DocumentFilter): DurableDocumentQuery {
  const query: Record<string, unknown> = {};
  const match = filter.entityMatch ?? "any";
  const issuers = idConstraint(filter.issuerIds, match);
  const instruments = idConstraint(filter.instrumentIds, match);
  if (issuers) query.issuerIds = issuers;
  if (instruments) query.instrumentIds = instruments;
  if (filter.kinds?.length) query.kind = { $in: [...filter.kinds] };
  if (filter.currencies?.length) {
    query.currency = { $in: [...filter.currencies] };
  }

  const temporalField = filter.temporal?.field ?? "published";
  const temporalRange = rangeConstraint(
    filter.temporal?.from,
    filter.temporal?.to
  );
  if (temporalRange && !filter.temporal?.includeUndated) {
    query[
      temporalField === "event"
        ? "eventAt"
        : temporalField === "fetched"
          ? "fetchedAt"
          : "publishedAt"
    ] = temporalRange;
  }
  const publishedRange = rangeConstraint(
    filter.publishedAfter,
    filter.publishedBefore
  );
  const eventRange = rangeConstraint(filter.eventAfter, filter.eventBefore);
  const fetchedRange = rangeConstraint(filter.fetchedAfter, filter.fetchedBefore);
  if (publishedRange) query.publishedAt = publishedRange;
  if (eventRange) query.eventAt = eventRange;
  if (fetchedRange) query.fetchedAt = fetchedRange;
  return query;
}

async function cursorRecords(
  result: readonly DurableDocumentRecord[] | DurableDocumentCursor
): Promise<readonly DurableDocumentRecord[]> {
  return "toArray" in result ? await result.toArray() : result;
}

/**
 * Reference store for tests and local execution. Versions are retained until
 * explicitly discarded with the store instance; there is no 90-day TTL.
 */
export class InMemoryDocumentStore implements LongRetentionDocumentStore {
  readonly retentionPolicy = LONG_RETENTION_POLICY;
  readonly #documents = new Map<
    string,
    Map<string, NormalizedDocument>
  >();

  constructor(documents: readonly NormalizedDocument[] = []) {
    this.putMany(documents);
  }

  put(document: NormalizedDocument): void {
    const issues = validateNormalizedDocument(document);
    if (issues.length > 0) {
      throw new TypeError(`Invalid document: ${issues.join(", ")}`);
    }
    const id = documentIdentity(document);
    const versions =
      this.#documents.get(id) ?? new Map<string, NormalizedDocument>();
    const existing = versions.get(document.contentVersion);
    if (existing && !sameDocument(existing, document)) {
      throw new Error(
        `Immutable document version conflict: ${id}@${document.contentVersion}`
      );
    }
    if (existing) return;
    versions.set(document.contentVersion, immutableDocument(document));
    this.#documents.set(id, versions);
  }

  putMany(documents: readonly NormalizedDocument[]): void {
    const invalid = documents
      .map((document) => ({
        id: documentIdentity(document),
        issues: validateNormalizedDocument(document),
      }))
      .filter(({ issues }) => issues.length > 0);
    if (invalid.length > 0) {
      throw new TypeError(
        `Invalid documents: ${invalid
          .map(({ id, issues }) => `${id || "<unknown>"} (${issues.join(", ")})`)
          .join("; ")}`
      );
    }
    for (const document of documents) this.put(document);
  }

  get(
    documentId: string,
    contentVersion?: string
  ): NormalizedDocument | undefined {
    const versions = this.#documents.get(documentId);
    if (!versions) return undefined;
    if (contentVersion) return versions.get(contentVersion);
    return [...versions.values()].sort(newestFirst)[0];
  }

  list(filter: DocumentFilter = {}): readonly NormalizedDocument[] {
    const allVersions = [...this.#documents.values()].flatMap((versions) =>
      filter.includeAllVersions
        ? [...versions.values()]
        : [[...versions.values()].sort(newestFirst)[0]].filter(
            (document): document is NormalizedDocument => Boolean(document)
          )
    );
    const matching = allVersions
      .filter((document) => filterDocument(document, filter).accepted)
      .sort(newestFirst);
    return matching.slice(0, Math.max(0, filter.limit ?? matching.length));
  }

  get documentCount(): number {
    return this.#documents.size;
  }

  get versionCount(): number {
    return [...this.#documents.values()].reduce(
      (total, versions) => total + versions.size,
      0
    );
  }
}

export { InMemoryDocumentStore as MemoryDocumentStore };

/**
 * Production adapter for a durable collection. Each document version has its
 * own immutable key; this adapter never writes expiry metadata or deletes by
 * age, including the legacy 90-day news boundary.
 */
export class DurableCollectionDocumentStore
  implements LongRetentionDocumentStore
{
  readonly retentionPolicy = LONG_RETENTION_POLICY;
  readonly #collection: DurableDocumentCollection;
  readonly #scanLimit: number;

  constructor(
    collection: DurableDocumentCollection,
    options: { scanLimit?: number } = {}
  ) {
    this.#collection = collection;
    this.#scanLimit = Math.max(1, options.scanLimit ?? 5_000);
  }

  async put(document: NormalizedDocument): Promise<void> {
    const issues = validateNormalizedDocument(document);
    if (issues.length > 0) {
      throw new TypeError(`Invalid document: ${issues.join(", ")}`);
    }
    const record = toRecord(document);
    const existing = await this.#collection.findOne({ _id: record._id });
    if (existing) {
      if (!sameDocument(existing.document, record.document)) {
        throw new Error(
          `Immutable document version conflict: ${record.documentId}@${record.contentVersion}`
        );
      }
      return;
    }
    try {
      await this.#collection.insertOne(record);
    } catch (error) {
      // Resolve a concurrent idempotent insert without weakening immutability.
      const raced = await this.#collection.findOne({ _id: record._id });
      if (raced && sameDocument(raced.document, record.document)) return;
      throw error;
    }
  }

  async putMany(documents: readonly NormalizedDocument[]): Promise<void> {
    for (const document of documents) await this.put(document);
  }

  async get(
    documentId: string,
    contentVersion?: string
  ): Promise<NormalizedDocument | undefined> {
    if (contentVersion) {
      const record = await this.#collection.findOne({
        _id: recordId(documentId, contentVersion),
      });
      return record?.document;
    }
    const result = await this.#collection.find(
      { documentId },
      { sort: { fetchedAt: -1 }, limit: this.#scanLimit }
    );
    return (await cursorRecords(result))
      .map((record) => record.document)
      .sort(newestFirst)[0];
  }

  async list(
    filter: DocumentFilter = {}
  ): Promise<readonly NormalizedDocument[]> {
    const requestedLimit = Math.max(0, filter.limit ?? this.#scanLimit);
    if (requestedLimit === 0) return [];
    const backendLimit = filter.includeAllVersions
      ? requestedLimit
      : Math.min(this.#scanLimit, Math.max(requestedLimit, requestedLimit * 10));
    const result = await this.#collection.find(durableQuery(filter), {
      sort: { fetchedAt: -1 },
      limit: backendLimit,
    });
    const records = await cursorRecords(result);
    const valid = records
      .map((record) => record.document)
      .filter((document) => filterDocument(document, filter).accepted);
    const selected = filter.includeAllVersions
      ? valid
      : [
          ...valid
            .reduce((latest, document) => {
              const id = documentIdentity(document);
              const current = latest.get(id);
              if (!current || newestFirst(document, current) < 0) {
                latest.set(id, document);
              }
              return latest;
            }, new Map<string, NormalizedDocument>())
            .values(),
        ];
    return selected.sort(newestFirst).slice(0, requestedLimit);
  }
}

export { DurableCollectionDocumentStore as LongRetentionDocumentStoreAdapter };

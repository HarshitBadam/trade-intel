import {
  documentIdentity,
  documentText,
  type EvidenceItem,
  type EvidenceLedgerEntry,
  type EvidenceLedgerSnapshot,
  type EvidenceRejectionReason,
  type FusedRetrievalHit,
  type NormalizedDocument,
  type RetrievalChannel,
} from "./types";

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function immutableItem(item: EvidenceItem): EvidenceItem {
  return Object.freeze({
    ...item,
    issuerIds: Object.freeze([...item.issuerIds]),
    instrumentIds: Object.freeze([...item.instrumentIds]),
    units: Object.freeze([...item.units]),
    channels: Object.freeze([...item.channels]),
    scores: Object.freeze({ ...item.scores }),
    provenance: Object.freeze({ ...item.provenance }),
  });
}

export function evidenceItemFromDocument(
  document: NormalizedDocument,
  options: {
    channels?: readonly RetrievalChannel[];
    lexicalScore?: number;
    semanticScore?: number;
    liveScore?: number;
    fusedScore?: number;
    rerankerScore?: number;
  } = {}
): EvidenceItem {
  const id = documentIdentity(document);
  const channels = options.channels ?? [];
  return immutableItem({
    evidenceId: `ev_${stableHash(`${id}:${document.contentVersion}`)}`,
    documentId: id,
    contentVersion: document.contentVersion,
    kind: document.kind,
    title: document.title,
    excerpt: document.excerpt ?? documentText(document).slice(0, 1_200),
    issuerIds: document.issuerIds,
    instrumentIds: document.instrumentIds,
    eventAt: document.eventAt,
    publishedAt: document.publishedAt,
    fetchedAt: document.fetchedAt,
    units: document.units ?? [],
    currency: document.currency,
    provenance: document.provenance,
    channels,
    scores: {
      lexical: options.lexicalScore,
      semantic: options.semanticScore,
      live: options.liveScore,
      fused: options.fusedScore ?? 0,
      reranker: options.rerankerScore,
    },
  });
}

export function evidenceItemFromHit(hit: FusedRetrievalHit): EvidenceItem {
  return evidenceItemFromDocument(hit.document, {
    channels: hit.channels,
    lexicalScore: hit.componentScores.lexical,
    semanticScore: hit.componentScores.semantic,
    liveScore: hit.componentScores.live,
    fusedScore: hit.fusedScore,
    rerankerScore: hit.rerankerScore,
  });
}

/**
 * Append-only decision log. Selection never overwrites observation and
 * rejection records, so diagnostics remain auditable after ranking.
 */
export class EvidenceLedger {
  readonly ledgerId: string;
  readonly createdAt: string;
  readonly #clock: () => Date;
  readonly #entries: EvidenceLedgerEntry[] = [];

  constructor(options: {
    ledgerId?: string;
    seed?: string;
    createdAt?: string;
    clock?: () => Date;
  } = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.createdAt = options.createdAt ?? this.#clock().toISOString();
    this.ledgerId =
      options.ledgerId ??
      `ledger_${stableHash(`${options.seed ?? ""}:${this.createdAt}`)}`;
  }

  get entries(): readonly EvidenceLedgerEntry[] {
    return Object.freeze([...this.#entries]);
  }

  observe(item: EvidenceItem, rank?: number, detail?: string): void {
    this.#append({ decision: "observed", item, rank, detail });
  }

  select(item: EvidenceItem, rank: number, detail?: string): void {
    this.#append({ decision: "selected", item, rank, detail });
  }

  reject(
    item: EvidenceItem,
    reason: EvidenceRejectionReason,
    detail?: string,
    rank?: number
  ): void {
    this.#append({ decision: "rejected", item, reason, detail, rank });
  }

  selected(): readonly EvidenceLedgerEntry[] {
    return this.entries.filter((entry) => entry.decision === "selected");
  }

  rejected(): readonly EvidenceLedgerEntry[] {
    return this.entries.filter((entry) => entry.decision === "rejected");
  }

  snapshot(): EvidenceLedgerSnapshot {
    return Object.freeze({
      ledgerId: this.ledgerId,
      createdAt: this.createdAt,
      entries: this.entries,
    });
  }

  #append(
    entry: Omit<EvidenceLedgerEntry, "sequence" | "recordedAt">
  ): void {
    this.#entries.push(
      Object.freeze({
        ...entry,
        sequence: this.#entries.length + 1,
        recordedAt: this.#clock().toISOString(),
        item: immutableItem(entry.item),
      })
    );
  }
}

export const DOCUMENT_KINDS = [
  "news",
  "filing",
  "transcript",
  "press_release",
  "research",
  "web",
  "other",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type IsoTimestamp = string;
export type IssuerId = string;
export type InstrumentId = string;
export type CurrencyCode = string;
export type Unit = string;

export type Provenance = {
  provider: string;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl?: string;
  publisher?: string;
  fetchedBy?: string;
  upstreamIds?: Readonly<Record<string, string>>;
  authorityScore?: number;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
};

type DocumentIdentity =
  | { documentId: string; docId?: string; id?: string }
  | { documentId?: string; docId: string; id?: string }
  | { documentId?: string; docId?: string; id: string };

/**
 * Provider-neutral document representation. A document is immutable at a
 * content version; a later revision uses the same identity and a new version.
 */
export type NormalizedDocument = DocumentIdentity & {
  kind: DocumentKind;
  title: string;
  content?: string;
  excerpt?: string;
  issuerIds: readonly IssuerId[];
  instrumentIds: readonly InstrumentId[];
  eventAt?: IsoTimestamp;
  publishedAt?: IsoTimestamp;
  fetchedAt: IsoTimestamp;
  contentVersion: string;
  units?: readonly Unit[];
  currency?: CurrencyCode;
  provenance: Provenance;
  metadata?: Readonly<Record<string, unknown>>;
};

export type TemporalField = "event" | "published" | "fetched";

export type TemporalFilter = {
  field?: TemporalField;
  from?: IsoTimestamp;
  to?: IsoTimestamp;
  /** Undated documents fail bounded temporal filters unless explicitly allowed. */
  includeUndated?: boolean;
};

export type EntityMatch = "any" | "all";

export type DocumentFilter = {
  issuerIds?: readonly IssuerId[];
  instrumentIds?: readonly InstrumentId[];
  entityMatch?: EntityMatch;
  kinds?: readonly DocumentKind[];
  temporal?: TemporalFilter;
  publishedAfter?: IsoTimestamp;
  publishedBefore?: IsoTimestamp;
  eventAfter?: IsoTimestamp;
  eventBefore?: IsoTimestamp;
  fetchedAfter?: IsoTimestamp;
  fetchedBefore?: IsoTimestamp;
  currencies?: readonly CurrencyCode[];
  includeAllVersions?: boolean;
  limit?: number;
};

export type RetrievalChannel = "lexical" | "semantic" | "live";

export type RetrievalHit = {
  document: NormalizedDocument;
  channel: RetrievalChannel;
  score: number;
  rank?: number;
  provider?: string;
  lexicalScore?: number;
  semanticScore?: number;
  liveScore?: number;
  fusedScore?: number;
  rerankerScore?: number;
};

export type FusedRetrievalHit = RetrievalHit & {
  channels: readonly RetrievalChannel[];
  fusedScore: number;
  componentScores: Readonly<
    Partial<Record<RetrievalChannel, number>>
  >;
};

export const EVIDENCE_REJECTION_REASONS = [
  "invalid_document",
  "entity_mismatch",
  "document_type_mismatch",
  "temporal_mismatch",
  "currency_mismatch",
  "low_relevance",
  "duplicate",
  "source_diversity",
  "reranker_rejected",
] as const;

export type EvidenceRejectionReason =
  (typeof EVIDENCE_REJECTION_REASONS)[number];

export type EvidenceScoreBreakdown = {
  lexical?: number;
  semantic?: number;
  live?: number;
  fused: number;
  reranker?: number;
};

export type EvidenceItem = {
  evidenceId: string;
  documentId: string;
  contentVersion: string;
  kind: DocumentKind;
  title: string;
  excerpt: string;
  issuerIds: readonly IssuerId[];
  instrumentIds: readonly InstrumentId[];
  eventAt?: IsoTimestamp;
  publishedAt?: IsoTimestamp;
  fetchedAt: IsoTimestamp;
  units: readonly Unit[];
  currency?: CurrencyCode;
  provenance: Provenance;
  channels: readonly RetrievalChannel[];
  scores: EvidenceScoreBreakdown;
};

export type EvidenceDecision = "observed" | "selected" | "rejected";

export type EvidenceLedgerEntry = {
  sequence: number;
  recordedAt: IsoTimestamp;
  decision: EvidenceDecision;
  item: EvidenceItem;
  rank?: number;
  reason?: EvidenceRejectionReason;
  detail?: string;
};

export type EvidenceLedgerSnapshot = {
  ledgerId: string;
  createdAt: IsoTimestamp;
  entries: readonly EvidenceLedgerEntry[];
};

export type RetrievalQuery = {
  queryId: string;
  text: string;
  filter?: DocumentFilter;
  limit?: number;
  candidateLimit?: number;
  minimumArchiveResults?: number;
  currentAsk?: boolean;
  allowSemantic?: boolean;
  allowLive?: boolean;
  maxPerSource?: number;
};

export type LiveFallbackReason =
  | "current_ask"
  | "archive_gap"
  | "not_needed"
  | "not_allowed"
  | "unavailable";

export type RetrievalDiagnostics = {
  archiveDocuments: number;
  eligibleArchiveDocuments: number;
  lexicalHits: number;
  semanticHits: number;
  liveHits: number;
  fusedHits: number;
  selected: number;
  rejected: Readonly<Partial<Record<EvidenceRejectionReason, number>>>;
  liveFallbackReason: LiveFallbackReason;
};

export type HybridRetrievalResult = {
  items: readonly EvidenceItem[];
  documents: readonly NormalizedDocument[];
  ledger: EvidenceLedgerSnapshot;
  diagnostics: RetrievalDiagnostics;
};

export function documentIdentity(document: NormalizedDocument): string {
  return document.documentId ?? document.docId ?? document.id ?? "";
}

export function documentText(document: NormalizedDocument): string {
  return document.content ?? document.excerpt ?? "";
}

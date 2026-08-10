import {
  DOCUMENT_KINDS,
  documentIdentity,
  documentText,
  type DocumentFilter,
  type EvidenceRejectionReason,
  type NormalizedDocument,
  type TemporalField,
} from "./types";

export type FilterDecision =
  | { accepted: true }
  | {
      accepted: false;
      reason: EvidenceRejectionReason;
      detail: string;
    };

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validTimestamp(value: string | undefined): boolean {
  return value === undefined || timestamp(value) !== undefined;
}

function hasRequestedIds(
  actual: readonly string[],
  requested: readonly string[],
  match: "any" | "all"
): boolean {
  if (requested.length === 0) return true;
  const actualIds = new Set(actual);
  return match === "all"
    ? requested.every((id) => actualIds.has(id))
    : requested.some((id) => actualIds.has(id));
}

function within(
  value: string | undefined,
  from: string | undefined,
  to: string | undefined,
  includeUndated = false
): boolean {
  if (!from && !to) return true;
  const actual = timestamp(value);
  if (actual === undefined) return includeUndated;
  const lower = timestamp(from);
  const upper = timestamp(to);
  if (from && lower === undefined) return false;
  if (to && upper === undefined) return false;
  return (lower === undefined || actual >= lower) &&
    (upper === undefined || actual <= upper);
}

function timeFor(
  document: NormalizedDocument,
  field: TemporalField
): string | undefined {
  if (field === "event") return document.eventAt;
  if (field === "fetched") return document.fetchedAt;
  return document.publishedAt;
}

export function validateNormalizedDocument(
  document: NormalizedDocument
): readonly string[] {
  const issues: string[] = [];
  if (!documentIdentity(document).trim()) issues.push("missing document identity");
  if (!DOCUMENT_KINDS.includes(document.kind)) issues.push("unknown document kind");
  if (!document.title.trim()) issues.push("missing title");
  if (!documentText(document).trim()) issues.push("missing content");
  if (!document.contentVersion.trim()) issues.push("missing content version");
  if (!validTimestamp(document.eventAt)) issues.push("invalid event time");
  if (!validTimestamp(document.publishedAt)) {
    issues.push("invalid publication time");
  }
  if (!validTimestamp(document.fetchedAt)) issues.push("invalid fetch time");
  if (!document.provenance.provider.trim()) {
    issues.push("missing provenance provider");
  }
  if (!document.provenance.sourceId.trim()) {
    issues.push("missing provenance source id");
  }
  if (!document.provenance.sourceUrl.trim()) {
    issues.push("missing provenance source URL");
  }
  return issues;
}

export function filterDocument(
  document: NormalizedDocument,
  filter: DocumentFilter = {}
): FilterDecision {
  const validationIssues = validateNormalizedDocument(document);
  if (validationIssues.length > 0) {
    return {
      accepted: false,
      reason: "invalid_document",
      detail: validationIssues.join(", "),
    };
  }

  if (filter.kinds?.length && !filter.kinds.includes(document.kind)) {
    return {
      accepted: false,
      reason: "document_type_mismatch",
      detail: `kind ${document.kind} was not requested`,
    };
  }

  const entityMatch = filter.entityMatch ?? "any";
  if (
    filter.issuerIds?.length &&
    !hasRequestedIds(document.issuerIds, filter.issuerIds, entityMatch)
  ) {
    return {
      accepted: false,
      reason: "entity_mismatch",
      detail: "issuer IDs did not match",
    };
  }
  if (
    filter.instrumentIds?.length &&
    !hasRequestedIds(document.instrumentIds, filter.instrumentIds, entityMatch)
  ) {
    return {
      accepted: false,
      reason: "entity_mismatch",
      detail: "instrument IDs did not match",
    };
  }

  if (
    filter.currencies?.length &&
    (!document.currency || !filter.currencies.includes(document.currency))
  ) {
    return {
      accepted: false,
      reason: "currency_mismatch",
      detail: "currency did not match",
    };
  }

  const temporal = filter.temporal;
  if (
    temporal &&
    !within(
      timeFor(document, temporal.field ?? "published"),
      temporal.from,
      temporal.to,
      temporal.includeUndated
    )
  ) {
    return {
      accepted: false,
      reason: "temporal_mismatch",
      detail: `${temporal.field ?? "published"} time was outside the requested range`,
    };
  }
  if (
    !within(
      document.publishedAt,
      filter.publishedAfter,
      filter.publishedBefore
    ) ||
    !within(document.eventAt, filter.eventAfter, filter.eventBefore) ||
    !within(document.fetchedAt, filter.fetchedAfter, filter.fetchedBefore)
  ) {
    return {
      accepted: false,
      reason: "temporal_mismatch",
      detail: "document time was outside the requested range",
    };
  }

  return { accepted: true };
}

export function filterDocuments(
  documents: readonly NormalizedDocument[],
  filter: DocumentFilter = {}
): {
  accepted: NormalizedDocument[];
  rejected: Array<{
    document: NormalizedDocument;
    reason: EvidenceRejectionReason;
    detail: string;
  }>;
} {
  const accepted: NormalizedDocument[] = [];
  const rejected: Array<{
    document: NormalizedDocument;
    reason: EvidenceRejectionReason;
    detail: string;
  }> = [];
  for (const document of documents) {
    const decision = filterDocument(document, filter);
    if (decision.accepted) {
      accepted.push(document);
    } else {
      rejected.push({ document, ...decision });
    }
  }
  return { accepted, rejected };
}

import {
  documentIdentity,
  documentText,
  type EvidenceRejectionReason,
  type FusedRetrievalHit,
} from "./types";

const TRACKING_PARAMETERS = [
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
];

export function canonicalizeDocumentUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.includes(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname =
      url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return url.toString();
  } catch {
    return value.trim().toLocaleLowerCase();
  }
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function duplicateKeys(hit: FusedRetrievalHit): string[] {
  const document = hit.document;
  const url = canonicalizeDocumentUrl(
    document.provenance.canonicalUrl ?? document.provenance.sourceUrl
  );
  const sourceIdentity = `${document.provenance.provider.toLocaleLowerCase()}:${document.provenance.sourceId}`;
  const contentIdentity = normalizedText(
    `${document.title} ${documentText(document).slice(0, 500)}`
  );
  return [
    `document:${documentIdentity(document)}:${document.contentVersion}`,
    `url:${url}`,
    `source:${sourceIdentity}`,
    `content:${contentIdentity}`,
  ];
}

export function deduplicateHits(
  hits: readonly FusedRetrievalHit[]
): {
  kept: FusedRetrievalHit[];
  rejected: Array<{
    hit: FusedRetrievalHit;
    reason: "duplicate";
    detail: string;
  }>;
} {
  const seen = new Map<string, string>();
  const kept: FusedRetrievalHit[] = [];
  const rejected: Array<{
    hit: FusedRetrievalHit;
    reason: "duplicate";
    detail: string;
  }> = [];

  for (const hit of hits) {
    const keys = duplicateKeys(hit);
    const matchingKey = keys.find((key) => seen.has(key));
    if (matchingKey) {
      rejected.push({
        hit,
        reason: "duplicate",
        detail: `duplicate of ${seen.get(matchingKey)}`,
      });
      continue;
    }
    const id = documentIdentity(hit.document);
    for (const key of keys) seen.set(key, id);
    kept.push(hit);
  }
  return { kept, rejected };
}

export function sourceIdentity(hit: FusedRetrievalHit): string {
  const provenance = hit.document.provenance;
  if (provenance.publisher?.trim()) {
    return `publisher:${provenance.publisher.trim().toLocaleLowerCase()}`;
  }
  try {
    return `host:${new URL(
      provenance.canonicalUrl ?? provenance.sourceUrl
    ).hostname
      .toLocaleLowerCase()
      .replace(/^www\./, "")}`;
  } catch {
    return `provider:${provenance.provider.toLocaleLowerCase()}`;
  }
}

export function selectSourceDiverseHits(
  hits: readonly FusedRetrievalHit[],
  options: { limit: number; maxPerSource: number }
): {
  selected: FusedRetrievalHit[];
  rejected: Array<{
    hit: FusedRetrievalHit;
    reason: EvidenceRejectionReason;
    detail: string;
  }>;
} {
  const selected: FusedRetrievalHit[] = [];
  const rejected: Array<{
    hit: FusedRetrievalHit;
    reason: EvidenceRejectionReason;
    detail: string;
  }> = [];
  const bySource = new Map<string, number>();
  const limit = Math.max(0, options.limit);
  const maxPerSource = Math.max(1, options.maxPerSource);

  for (const hit of hits) {
    const source = sourceIdentity(hit);
    const sourceCount = bySource.get(source) ?? 0;
    if (sourceCount >= maxPerSource) {
      rejected.push({
        hit,
        reason: "source_diversity",
        detail: `${source} exceeded maxPerSource=${maxPerSource}`,
      });
      continue;
    }
    if (selected.length >= limit) {
      rejected.push({
        hit,
        reason: "low_relevance",
        detail: `ranked below result limit ${limit}`,
      });
      continue;
    }
    selected.push(hit);
    bySource.set(source, sourceCount + 1);
  }
  return { selected, rejected };
}

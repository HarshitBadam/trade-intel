import { InMemoryBm25LexicalIndex } from "./bm25";
import { filterDocuments } from "./filters";
import {
  reciprocalRankFusion,
  type RrfOptions,
  type RrfRankedList,
} from "./fusion";
import {
  EvidenceLedger,
  evidenceItemFromDocument,
  evidenceItemFromHit,
} from "./ledger";
import { NoopSemanticIndex } from "./ports";
import type {
  DocumentStore,
  LexicalIndex,
  LiveSearch,
  Reranker,
  SemanticIndex,
} from "./ports";
import { HeuristicReranker } from "./reranker";
import {
  deduplicateHits,
  selectSourceDiverseHits,
} from "./selection";
import {
  documentIdentity,
  type DocumentFilter,
  type EvidenceItem,
  type FusedRetrievalHit,
  type HybridRetrievalResult,
  type LiveFallbackReason,
  type RetrievalChannel,
  type RetrievalDiagnostics,
  type RetrievalHit,
  type RetrievalQuery,
} from "./types";

export type HybridDocumentPorts = {
  store: DocumentStore;
  lexical?: LexicalIndex;
  semantic?: SemanticIndex;
  live?: LiveSearch;
  reranker?: Reranker;
};

export type HybridRetrievalOptions = {
  rrf?: RrfOptions;
  ledger?: EvidenceLedger;
};

function hitKey(hit: { document: RetrievalHit["document"] }): string {
  return `${documentIdentity(hit.document)}::${hit.document.contentVersion}`;
}

function normalizedHits(
  hits: readonly RetrievalHit[],
  channel: RetrievalChannel
): RetrievalHit[] {
  return hits
    .filter((hit) => Number.isFinite(hit.score))
    .map((hit, index) => ({
      ...hit,
      channel,
      rank: index + 1,
      lexicalScore: channel === "lexical" ? hit.score : hit.lexicalScore,
      semanticScore: channel === "semantic" ? hit.score : hit.semanticScore,
      liveScore: channel === "live" ? hit.score : hit.liveScore,
    }));
}

function countRejected(
  ledger: EvidenceLedger
): RetrievalDiagnostics["rejected"] {
  const rejected: Partial<
    Record<
      NonNullable<ReturnType<EvidenceLedger["rejected"]>[number]["reason"]>,
      number
    >
  > = {};
  for (const entry of ledger.rejected()) {
    if (!entry.reason) continue;
    rejected[entry.reason] = (rejected[entry.reason] ?? 0) + 1;
  }
  return rejected;
}

async function safelySearch(
  operation: () =>
    | readonly RetrievalHit[]
    | Promise<readonly RetrievalHit[]>
): Promise<readonly RetrievalHit[]> {
  try {
    return await operation();
  } catch {
    return [];
  }
}

function strictHitFilter(args: {
  hits: readonly RetrievalHit[];
  filter: DocumentFilter;
  ledger: EvidenceLedger;
}): RetrievalHit[] {
  const { accepted, rejected } = filterDocuments(
    args.hits.map((hit) => hit.document),
    args.filter
  );
  const acceptedDocuments = new Set(accepted);
  for (const rejection of rejected) {
    args.ledger.reject(
      evidenceItemFromDocument(rejection.document, {
        channels: [],
      }),
      rejection.reason,
      rejection.detail
    );
  }
  return args.hits.filter((hit) => acceptedDocuments.has(hit.document));
}

async function rerankKnownHits(args: {
  query: string;
  hits: readonly FusedRetrievalHit[];
  reranker: Reranker;
  ledger: EvidenceLedger;
}): Promise<FusedRetrievalHit[]> {
  const allowed = new Map(args.hits.map((hit) => [hitKey(hit), hit]));
  const reranked = await args.reranker.rerank(
    args.query,
    args.hits,
    args.hits.length
  );
  const seen = new Set<string>();
  const accepted: FusedRetrievalHit[] = [];
  for (const hit of reranked) {
    const key = hitKey(hit);
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    accepted.push(hit);
  }
  for (const [key, hit] of allowed) {
    if (seen.has(key)) continue;
    args.ledger.reject(
      evidenceItemFromHit(hit),
      "reranker_rejected",
      "reranker omitted candidate"
    );
  }
  return accepted;
}

export async function retrieveDocumentsHybrid(args: {
  query: RetrievalQuery;
  ports: HybridDocumentPorts;
  options?: HybridRetrievalOptions;
}): Promise<HybridRetrievalResult> {
  const query = args.query;
  const limit = Math.max(0, query.limit ?? 8);
  const candidateLimit = Math.max(limit, query.candidateLimit ?? 500);
  const minimumArchiveResults = Math.max(
    1,
    query.minimumArchiveResults ?? 1
  );
  const filter = query.filter ?? {};
  const lexical = args.ports.lexical ?? new InMemoryBm25LexicalIndex();
  const semantic = args.ports.semantic ?? new NoopSemanticIndex();
  const reranker = args.ports.reranker ?? new HeuristicReranker();
  const ledger =
    args.options?.ledger ??
    new EvidenceLedger({ seed: `${query.queryId}:${query.text}` });

  const archivePromise = Promise.resolve(
    args.ports.store.list({
      ...filter,
      includeAllVersions: false,
      limit: candidateLimit,
    })
  );
  const semanticPromise = query.allowSemantic
    ? safelySearch(() => semantic.search(query.text, filter, candidateLimit))
    : Promise.resolve([]);
  // An explicit current ask is not a fallback: start its live lane beside the
  // archive and semantic lanes so provider latency is not serialized.
  const currentLivePromise =
    query.currentAsk && query.allowLive !== false && args.ports.live
      ? safelySearch(() => args.ports.live!.search(query))
      : Promise.resolve(undefined);
  const [archiveDocuments, semanticCandidates, currentLiveCandidates] =
    await Promise.all([
      archivePromise,
      semanticPromise,
      currentLivePromise,
    ]);

  const archiveFiltered = filterDocuments(archiveDocuments, filter);
  for (const rejection of archiveFiltered.rejected) {
    ledger.reject(
      evidenceItemFromDocument(rejection.document),
      rejection.reason,
      rejection.detail
    );
  }
  const lexicalHits = normalizedHits(
    await lexical.search(query.text, archiveFiltered.accepted, candidateLimit),
    "lexical"
  );
  const semanticHits = normalizedHits(
    strictHitFilter({
      hits: normalizedHits(semanticCandidates, "semantic"),
      filter,
      ledger,
    }),
    "semantic"
  );
  const archiveLists: RrfRankedList[] = [
    { channel: "lexical", hits: lexicalHits },
  ];
  if (query.allowSemantic) {
    archiveLists.push({ channel: "semantic", hits: semanticHits });
  }
  const archiveFused = reciprocalRankFusion(archiveLists, {
    ...args.options?.rrf,
    limit: candidateLimit,
  });
  const distinctArchive = deduplicateHits(archiveFused).kept.length;
  const archiveGap = distinctArchive < minimumArchiveResults;

  let liveFallbackReason: LiveFallbackReason = "not_needed";
  let liveHits: RetrievalHit[] = [];
  if (query.currentAsk && query.allowLive === false) {
    liveFallbackReason = "not_allowed";
  } else if (query.currentAsk && !args.ports.live) {
    liveFallbackReason = "unavailable";
  } else if (query.currentAsk && args.ports.live) {
    liveFallbackReason = "current_ask";
    liveHits = normalizedHits(
      strictHitFilter({
        hits: normalizedHits(currentLiveCandidates ?? [], "live"),
        filter,
        ledger,
      }),
      "live"
    );
  } else if (archiveGap && query.allowLive === false) {
    liveFallbackReason = "not_allowed";
  } else if (archiveGap && !args.ports.live) {
    liveFallbackReason = "unavailable";
  } else if (archiveGap && args.ports.live) {
    liveFallbackReason = "archive_gap";
    const candidates = await safelySearch(() => args.ports.live!.search(query));
    liveHits = normalizedHits(
      strictHitFilter({
        hits: normalizedHits(candidates, "live"),
        filter,
        ledger,
      }),
      "live"
    );
  }

  const rankedLists = [...archiveLists];
  if (liveHits.length > 0) {
    rankedLists.push({ channel: "live", hits: liveHits });
  }
  const fused = reciprocalRankFusion(rankedLists, {
    ...args.options?.rrf,
    limit: candidateLimit,
  });
  fused.forEach((hit, index) =>
    ledger.observe(evidenceItemFromHit(hit), index + 1)
  );

  const represented = new Set(fused.map(hitKey));
  for (const document of archiveFiltered.accepted) {
    const key = `${documentIdentity(document)}::${document.contentVersion}`;
    if (represented.has(key)) continue;
    ledger.reject(
      evidenceItemFromDocument(document),
      "low_relevance",
      "document did not match lexical or semantic retrieval"
    );
  }

  const deduplicated = deduplicateHits(fused);
  for (const rejection of deduplicated.rejected) {
    ledger.reject(
      evidenceItemFromHit(rejection.hit),
      rejection.reason,
      rejection.detail,
      rejection.hit.rank
    );
  }
  const reranked = await rerankKnownHits({
    query: query.text,
    hits: deduplicated.kept,
    reranker,
    ledger,
  });
  const diverse = selectSourceDiverseHits(reranked, {
    limit,
    maxPerSource: query.maxPerSource ?? 2,
  });
  for (const rejection of diverse.rejected) {
    ledger.reject(
      evidenceItemFromHit(rejection.hit),
      rejection.reason,
      rejection.detail,
      rejection.hit.rank
    );
  }

  const items: EvidenceItem[] = diverse.selected.map((hit, index) => {
    const item = evidenceItemFromHit(hit);
    ledger.select(item, index + 1);
    return item;
  });
  const diagnostics: RetrievalDiagnostics = {
    archiveDocuments: archiveDocuments.length,
    eligibleArchiveDocuments: archiveFiltered.accepted.length,
    lexicalHits: lexicalHits.length,
    semanticHits: semanticHits.length,
    liveHits: liveHits.length,
    fusedHits: fused.length,
    selected: items.length,
    rejected: countRejected(ledger),
    liveFallbackReason,
  };

  return {
    items,
    documents: diverse.selected.map((hit) => hit.document),
    ledger: ledger.snapshot(),
    diagnostics,
  };
}

export class HybridDocumentRetriever {
  readonly #ports: HybridDocumentPorts;
  readonly #options: HybridRetrievalOptions;

  constructor(
    ports: HybridDocumentPorts,
    options: HybridRetrievalOptions = {}
  ) {
    this.#ports = ports;
    this.#options = options;
  }

  retrieve(query: RetrievalQuery): Promise<HybridRetrievalResult> {
    return retrieveDocumentsHybrid({
      query,
      ports: this.#ports,
      options: this.#options,
    });
  }
}

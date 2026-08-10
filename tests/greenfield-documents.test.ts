import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableCollectionDocumentStore,
  EvidenceLedger,
  InMemoryBm25LexicalIndex,
  InMemoryDocumentStore,
  filterDocument,
  reciprocalRankFusion,
  retrieveDocumentsHybrid,
  type DocumentStore,
  type DurableDocumentCollection,
  type DurableDocumentQuery,
  type DurableDocumentRecord,
  type NormalizedDocument,
  type RetrievalHit,
} from "../src/lib/stocksage/greenfield/documents";

function document(
  id: string,
  overrides: Partial<NormalizedDocument> = {}
): NormalizedDocument {
  return {
    documentId: id,
    kind: "news",
    title: `Document ${id}`,
    content: "General company update.",
    issuerIds: ["issuer:acme"],
    instrumentIds: ["instrument:ACME"],
    eventAt: "2026-07-10T12:00:00.000Z",
    publishedAt: "2026-07-10T13:00:00.000Z",
    fetchedAt: "2026-07-10T14:00:00.000Z",
    contentVersion: "v1",
    units: ["USD"],
    currency: "USD",
    provenance: {
      provider: "fixture",
      sourceId: id,
      sourceUrl: `https://example.com/${id}`,
      publisher: "Example News",
      authorityScore: 0.7,
    },
    ...overrides,
  };
}

function matchesQuery(
  record: DurableDocumentRecord,
  query: DurableDocumentQuery
): boolean {
  return Object.entries(query).every(([field, expected]) => {
    const actual = record[field as keyof DurableDocumentRecord];
    if (!expected || typeof expected !== "object") return actual === expected;
    const operators = expected as {
      $all?: readonly unknown[];
      $in?: readonly unknown[];
      $gte?: string;
      $lte?: string;
    };
    if (
      operators.$all &&
      (!Array.isArray(actual) ||
        !operators.$all.every((item) => actual.includes(item as never)))
    ) {
      return false;
    }
    if (
      operators.$in &&
      (Array.isArray(actual)
        ? !actual.some((item) => operators.$in?.includes(item))
        : !operators.$in.includes(actual))
    ) {
      return false;
    }
    if (operators.$gte && String(actual) < operators.$gte) return false;
    if (operators.$lte && String(actual) > operators.$lte) return false;
    return true;
  });
}

class FixtureDurableCollection implements DurableDocumentCollection {
  readonly records = new Map<string, DurableDocumentRecord>();

  insertOne(record: DurableDocumentRecord): void {
    if (this.records.has(record._id)) throw new Error("duplicate key");
    this.records.set(record._id, structuredClone(record));
  }

  findOne(query: DurableDocumentQuery): DurableDocumentRecord | undefined {
    return [...this.records.values()].find((record) =>
      matchesQuery(record, query)
    );
  }

  find(query: DurableDocumentQuery): readonly DurableDocumentRecord[] {
    return [...this.records.values()].filter((record) =>
      matchesQuery(record, query)
    );
  }
}

test("in-memory BM25 ranks exact financial terms above unrelated text", () => {
  const index = new InMemoryBm25LexicalIndex();
  const relevant = document("earnings", {
    title: "Acme earnings beat estimates",
    content: "Quarterly revenue grew and management raised guidance.",
  });
  const unrelated = document("office", {
    title: "Acme opens a new office",
    content: "Employees moved into the downtown building.",
  });

  const hits = index.search(
    "quarterly earnings revenue guidance",
    [unrelated, relevant],
    5
  );

  assert.equal(hits[0]?.document.documentId, "earnings");
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
});

test("long-retention store keeps old documents and every content version", () => {
  const old = document("filing", {
    kind: "filing",
    title: "Acme annual filing",
    content: "Annual revenue and risk factors.",
    publishedAt: "2021-02-01T00:00:00.000Z",
    fetchedAt: "2021-02-01T01:00:00.000Z",
  });
  const revised = document("filing", {
    ...old,
    content: "Amended annual revenue and risk factors.",
    contentVersion: "v2",
    fetchedAt: "2021-03-01T01:00:00.000Z",
  });
  const store = new InMemoryDocumentStore([old, revised]);

  assert.equal(store.retentionPolicy.automaticExpiration, false);
  assert.equal(store.retentionPolicy.retentionDays, null);
  assert.equal(store.versionCount, 2);
  assert.equal(store.list().length, 1);
  assert.equal(store.list({ includeAllVersions: true }).length, 2);
  assert.equal(store.get("filing")?.contentVersion, "v2");
  assert.equal(store.get("filing", "v1")?.publishedAt?.slice(0, 4), "2021");
});

test("durable store round-trips immutable versions without age expiry", async () => {
  const collection = new FixtureDurableCollection();
  const writer = new DurableCollectionDocumentStore(collection);
  const original = document("durable-filing", {
    kind: "filing",
    title: "Acme 2020 annual filing",
    content: "Acme reported annual revenue in its historical filing.",
    publishedAt: "2020-02-01T00:00:00.000Z",
    fetchedAt: "2020-02-01T01:00:00.000Z",
  });
  const amended = document("durable-filing", {
    ...original,
    content: "Acme amended annual revenue in its historical filing.",
    contentVersion: "v2",
    fetchedAt: "2020-03-01T01:00:00.000Z",
  });
  await writer.putMany([original, amended]);

  // A separate adapter instance proves reads are backed by the collection,
  // rather than process memory.
  const reader = new DurableCollectionDocumentStore(collection);
  const versions = await reader.list({
    issuerIds: ["issuer:acme"],
    kinds: ["filing"],
    publishedBefore: "2021-01-01T00:00:00.000Z",
    includeAllVersions: true,
  });

  assert.equal(reader.retentionPolicy.automaticExpiration, false);
  assert.equal(reader.retentionPolicy.retentionDays, null);
  assert.deepEqual(
    versions.map((item) => item.contentVersion).sort(),
    ["v1", "v2"]
  );
  assert.equal(
    (await reader.get("durable-filing"))?.contentVersion,
    "v2"
  );
  assert.equal(
    (await reader.get("durable-filing", "v1"))?.publishedAt?.slice(0, 4),
    "2020"
  );
  assert.equal(
    [...collection.records.values()].some((record) =>
      Object.hasOwn(record, "expiresAt")
    ),
    false
  );
  await assert.rejects(
    writer.put({
      ...original,
      content: "Conflicting bytes under the same immutable version.",
    }),
    /Immutable document version conflict/
  );
});

test("filters require explicit entity, type, currency, and bounded time matches", () => {
  const filing = document("strict", {
    kind: "filing",
    currency: "USD",
    publishedAt: "2025-03-01T00:00:00.000Z",
  });
  const accepted = filterDocument(filing, {
    issuerIds: ["issuer:acme"],
    instrumentIds: ["instrument:ACME"],
    kinds: ["filing"],
    currencies: ["USD"],
    temporal: {
      field: "published",
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-12-31T23:59:59.999Z",
    },
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(
    filterDocument(filing, {
      issuerIds: ["issuer:other"],
      kinds: ["filing"],
    }),
    {
      accepted: false,
      reason: "entity_mismatch",
      detail: "issuer IDs did not match",
    }
  );
  assert.equal(
    filterDocument(filing, { kinds: ["transcript"] }).accepted,
    false
  );
  assert.equal(
    filterDocument(filing, {
      publishedAfter: "2026-01-01T00:00:00.000Z",
    }).accepted,
    false
  );
});

test("RRF rewards documents returned by lexical and semantic lanes", () => {
  const shared = document("shared");
  const lexicalOnly = document("lexical-only");
  const semanticOnly = document("semantic-only");
  const hit = (
    item: NormalizedDocument,
    channel: RetrievalHit["channel"],
    score: number
  ): RetrievalHit => ({ document: item, channel, score });

  const fused = reciprocalRankFusion([
    {
      channel: "lexical",
      hits: [hit(lexicalOnly, "lexical", 100), hit(shared, "lexical", 1)],
    },
    {
      channel: "semantic",
      hits: [hit(shared, "semantic", 0.8), hit(semanticOnly, "semantic", 0.7)],
    },
  ]);

  assert.equal(fused[0]?.document.documentId, "shared");
  assert.deepEqual(new Set(fused[0]?.channels), new Set(["lexical", "semantic"]));
});

test("hybrid retrieval uses an optional semantic port without requiring it", async () => {
  let semanticCalls = 0;
  const shared = document("hybrid", {
    title: "Acme earnings outlook",
    content: "Acme raised its earnings outlook.",
  });
  const result = await retrieveDocumentsHybrid({
    query: {
      queryId: "semantic",
      text: "earnings outlook",
      filter: { issuerIds: ["issuer:acme"] },
      allowSemantic: true,
      allowLive: false,
    },
    ports: {
      store: new InMemoryDocumentStore([shared]),
      semantic: {
        search: () => {
          semanticCalls += 1;
          return [{ document: shared, channel: "semantic", score: 0.98 }];
        },
      },
    },
  });

  assert.equal(semanticCalls, 1);
  assert.deepEqual(
    new Set(result.items[0]?.channels),
    new Set(["lexical", "semantic"])
  );
});

test("current retrieval starts archive, semantic, and live lanes in parallel", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archive = document("parallel-archive", {
    title: "Acme current earnings",
    content: "Archived Acme earnings context.",
  });
  const live = document("parallel-live", {
    kind: "web",
    title: "Acme earnings today",
    content: "Acme published an earnings update today.",
    provenance: {
      provider: "live-fixture",
      sourceId: "parallel-live",
      sourceUrl: "https://live.example.com/parallel",
      publisher: "Live Example",
    },
  });
  const backing = new InMemoryDocumentStore([archive]);
  const store: DocumentStore = {
    retentionPolicy: backing.retentionPolicy,
    put: (item) => backing.put(item),
    putMany: (items) => backing.putMany(items),
    get: (documentId, contentVersion) =>
      backing.get(documentId, contentVersion),
    list: async (filter) => {
      events.push("archive");
      await gate;
      return backing.list(filter);
    },
  };

  const pending = retrieveDocumentsHybrid({
    query: {
      queryId: "parallel-current",
      text: "Acme earnings today",
      currentAsk: true,
      allowSemantic: true,
      allowLive: true,
      filter: { issuerIds: ["issuer:acme"] },
    },
    ports: {
      store,
      semantic: {
        search: async () => {
          events.push("semantic");
          await gate;
          return [{ document: archive, channel: "semantic", score: 0.8 }];
        },
      },
      live: {
        search: async () => {
          events.push("live");
          await gate;
          return [{ document: live, channel: "live", score: 0.9 }];
        },
      },
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedBeforeAnyLaneCompleted = [...events];
  release();
  const result = await pending;

  assert.deepEqual(startedBeforeAnyLaneCompleted, [
    "archive",
    "semantic",
    "live",
  ]);
  assert.equal(result.diagnostics.liveFallbackReason, "current_ask");
  assert.ok(result.items.some((item) => item.channels.includes("live")));
});

test("live search is skipped when archive coverage is sufficient", async () => {
  let liveCalls = 0;
  const store = new InMemoryDocumentStore([
    document("archive", {
      title: "Acme quarterly revenue guidance",
      content: "Acme raised quarterly revenue guidance.",
    }),
  ]);
  const result = await retrieveDocumentsHybrid({
    query: {
      queryId: "archive-only",
      text: "Acme revenue guidance",
      allowLive: true,
      filter: { issuerIds: ["issuer:acme"] },
    },
    ports: {
      store,
      live: {
        search: () => {
          liveCalls += 1;
          return [];
        },
      },
    },
  });

  assert.equal(liveCalls, 0);
  assert.equal(result.diagnostics.liveFallbackReason, "not_needed");
  assert.equal(result.items[0]?.documentId, "archive");
});

test("live fallback runs only for an archive gap or explicit current ask", async () => {
  let liveCalls = 0;
  const liveDocument = document("live", {
    kind: "web",
    title: "Acme revenue update today",
    content: "Acme issued a revenue update today.",
    provenance: {
      provider: "live-fixture",
      sourceId: "live",
      sourceUrl: "https://live.example.com/acme",
      publisher: "Live Example",
    },
  });
  const liveHit: RetrievalHit = {
    document: liveDocument,
    channel: "live",
    score: 0.9,
  };
  const ports = {
    store: new InMemoryDocumentStore([
      document("unrelated", {
        title: "Acme office",
        content: "The office changed floors.",
      }),
    ]),
    live: {
      search: () => {
        liveCalls += 1;
        return [liveHit];
      },
    },
  };

  const gap = await retrieveDocumentsHybrid({
    query: {
      queryId: "gap",
      text: "revenue update",
      filter: { issuerIds: ["issuer:acme"] },
      allowLive: true,
    },
    ports,
  });
  assert.equal(gap.diagnostics.liveFallbackReason, "archive_gap");
  assert.equal(gap.items[0]?.documentId, "live");

  await retrieveDocumentsHybrid({
    query: {
      queryId: "current",
      text: "Acme office",
      filter: { issuerIds: ["issuer:acme"] },
      allowLive: true,
      currentAsk: true,
    },
    ports,
  });
  assert.equal(liveCalls, 2);
});

test("retrieval ledger retains dedup, diversity, and selection decisions", async () => {
  const duplicateUrl = "https://same.example.com/story";
  const store = new InMemoryDocumentStore([
    document("first", {
      title: "Acme earnings revenue",
      content: "Acme earnings and revenue increased.",
      provenance: {
        provider: "fixture",
        sourceId: "first",
        sourceUrl: `${duplicateUrl}?utm_source=test`,
        publisher: "Same Publisher",
      },
    }),
    document("duplicate", {
      title: "Acme earnings revenue copy",
      content: "Acme earnings and revenue increased in a copied report.",
      provenance: {
        provider: "fixture",
        sourceId: "duplicate",
        sourceUrl: duplicateUrl,
        publisher: "Same Publisher",
      },
    }),
    document("same-publisher", {
      title: "Acme earnings margin",
      content: "Acme earnings included a wider operating margin.",
      provenance: {
        provider: "fixture",
        sourceId: "same-publisher",
        sourceUrl: "https://same.example.com/another",
        publisher: "Same Publisher",
      },
    }),
    document("independent", {
      title: "Independent Acme earnings review",
      content: "An independent review covered Acme earnings and revenue.",
      provenance: {
        provider: "fixture",
        sourceId: "independent",
        sourceUrl: "https://independent.example.com/acme",
        publisher: "Independent Publisher",
      },
    }),
  ]);

  const result = await retrieveDocumentsHybrid({
    query: {
      queryId: "ledger",
      text: "Acme earnings revenue",
      filter: { issuerIds: ["issuer:acme"] },
      limit: 3,
      maxPerSource: 1,
      allowLive: false,
    },
    ports: { store },
  });
  const rejectedReasons = result.ledger.entries
    .filter((entry) => entry.decision === "rejected")
    .map((entry) => entry.reason);

  assert.ok(rejectedReasons.includes("duplicate"));
  assert.ok(rejectedReasons.includes("source_diversity"));
  assert.equal(
    result.ledger.entries.filter((entry) => entry.decision === "selected")
      .length,
    result.items.length
  );
  assert.equal(result.items.length, 2);
});

test("evidence ledger is append-only and returns immutable snapshots", () => {
  const ledger = new EvidenceLedger({
    ledgerId: "ledger:test",
    createdAt: "2026-01-01T00:00:00.000Z",
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const item = {
    evidenceId: "ev:test",
    documentId: "doc:test",
    contentVersion: "v1",
    kind: "news" as const,
    title: "Test",
    excerpt: "Test evidence",
    issuerIds: ["issuer:test"],
    instrumentIds: ["instrument:TEST"],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    units: ["USD"],
    currency: "USD",
    provenance: {
      provider: "fixture",
      sourceId: "test",
      sourceUrl: "https://example.com/test",
    },
    channels: ["lexical" as const],
    scores: { lexical: 1, fused: 1 },
  };
  ledger.observe(item, 1);
  const firstSnapshot = ledger.snapshot();
  ledger.reject(item, "low_relevance");

  assert.equal(firstSnapshot.entries.length, 1);
  assert.equal(ledger.snapshot().entries.length, 2);
  assert.equal(Object.isFrozen(firstSnapshot.entries), true);
  assert.equal(ledger.rejected()[0]?.reason, "low_relevance");
});

import "./no-live-keys";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { EvidenceInput } from "../src/lib/stocksage/citations";
import {
  createProductionHybridDocumentPorts,
  type ProductionDocumentPortsInput,
} from "../src/lib/stocksage/greenfield/documents/production-ports";
import type { FinanceEntity } from "../src/lib/stocksage/types";
import type { SecFilingMetadata } from "../src/lib/market-data/sec-edgar";
import { createProvenance } from "../src/lib/market-data/provenance";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function appleEntity(): FinanceEntity {
  return {
    id: "issuer:apple",
    name: "Apple Inc.",
    query: "Apple",
    ticker: "AAPL",
    market: "us",
  };
}

function filingFixture(): SecFilingMetadata {
  return {
    accessionNumber: "0000320193-26-000001",
    cik: "0000320193",
    form: "10-Q",
    filedAt: "2026-02-01",
    periodOfReport: "2025-12-31",
    primaryDocument: "aapl-20251231.htm",
    primaryDocumentDescription: "Quarterly report",
    items: "2.02",
    isXbrl: true,
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm",
    documentUrl:
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20251231.htm",
    provenance: createProvenance({
      provider: "sec_edgar",
      fetchedAt: "2026-08-09T11:00:00.000Z",
      sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar",
    }),
  };
}

function baseInput(
  overrides: Partial<ProductionDocumentPortsInput> = {}
): ProductionDocumentPortsInput {
  return {
    queryId: "q-production",
    query: "Apple earnings",
    entities: [appleEntity()],
    kinds: ["news", "filing", "web"],
    now: NOW,
    limit: 8,
    ...overrides,
  };
}

test("production ports map Astra archive rows to news docs with canonical entity ids", async () => {
  const entity = appleEntity();
  const astraUrl = "https://news.example.com/aapl-earnings";
  let astraCalls = 0;
  let filingsCalls = 0;
  let tavilyCalls = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;

  try {
    const ports = await createProductionHybridDocumentPorts(
      baseInput({
        sources: {
          astra: async () => {
            astraCalls += 1;
            return [
              {
                kind: "astra",
                title: "  Apple beats estimates  ",
                outlet: "Example Wire",
                url: astraUrl,
                excerpt: "  Revenue and guidance both rose.  ",
                publishedAt: "2026-07-31T15:30:00.000Z",
                retrievedAt: "2026-08-01T09:00:00.000Z",
                score: 0.91,
                ticker: "AAPL",
                // Prefer canonical ids from the evidence row when present.
                entityIds: [entity.id],
              } satisfies EvidenceInput,
            ];
          },
          filings: async () => {
            filingsCalls += 1;
            return [];
          },
          tavily: async () => {
            tavilyCalls += 1;
            return [];
          },
        },
      })
    );

    const archived = await ports.store.list({
      kinds: ["news"],
      issuerIds: [entity.id],
    });
    assert.equal(astraCalls, 1);
    assert.equal(filingsCalls, 1);
    assert.equal(tavilyCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(archived.length, 1);
    const doc = archived[0]!;
    assert.equal(doc.kind, "news");
    assert.equal(doc.documentId, `astra:${digest(astraUrl)}`);
    assert.equal(doc.title, "Apple beats estimates");
    assert.equal(doc.content, "Revenue and guidance both rose.");
    assert.deepEqual(doc.issuerIds, [entity.id]);
    assert.deepEqual(doc.instrumentIds, [entity.id]);
    assert.equal(doc.publishedAt, "2026-07-31T15:30:00.000Z");
    assert.equal(doc.eventAt, "2026-07-31T15:30:00.000Z");
    assert.equal(doc.fetchedAt, "2026-08-01T09:00:00.000Z");
    assert.equal(doc.provenance.provider, "astra");
    assert.equal(doc.provenance.sourceUrl, astraUrl);
    assert.equal(doc.provenance.publisher, "Example Wire");
    assert.equal(doc.provenance.authorityScore, 0.91);
    assert.equal(doc.metadata?.ticker, "AAPL");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production ports map SEC filing metadata for a US ticker into filing docs", async () => {
  const entity = appleEntity();
  const filing = filingFixture();
  let filingsCalls = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;

  try {
    const ports = await createProductionHybridDocumentPorts(
      baseInput({
        intervals: [{ startSession: "2025-01-01", endSession: "2026-08-01" }],
        sources: {
          astra: async () => [],
          filings: async (ticker, options = {}) => {
            filingsCalls += 1;
            assert.equal(ticker, "AAPL");
            assert.equal(options.limit, 12);
            assert.equal(options.filedFrom, "2025-01-01");
            assert.equal(options.filedTo, "2026-08-01");
            return [filing];
          },
          tavily: async () => [],
        },
      })
    );

    const filings = await ports.store.list({
      kinds: ["filing"],
      issuerIds: [entity.id],
    });
    assert.equal(filingsCalls, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(filings.length, 1);
    const doc = filings[0]!;
    assert.equal(doc.documentId, `sec:${filing.accessionNumber}`);
    assert.equal(doc.kind, "filing");
    assert.equal(doc.title, "Apple Inc. 10-Q filing");
    const excerpt = doc.excerpt ?? "";
    assert.match(excerpt, /Quarterly report/);
    assert.match(excerpt, /Items: 2\.02/);
    assert.match(excerpt, /Reporting period: 2025-12-31/);
    assert.match(excerpt, /Filed 2026-02-01/);
    assert.deepEqual(doc.issuerIds, [entity.id]);
    assert.deepEqual(doc.instrumentIds, [entity.id]);
    assert.equal(doc.publishedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(doc.eventAt, "2025-12-31T00:00:00.000Z");
    assert.equal(doc.fetchedAt, "2026-08-09T11:00:00.000Z");
    assert.equal(doc.provenance.provider, "sec_edgar");
    assert.equal(doc.provenance.sourceUrl, filing.documentUrl);
    assert.equal(doc.provenance.canonicalUrl, filing.url);
    assert.equal(doc.provenance.publisher, "U.S. Securities and Exchange Commission");
    assert.deepEqual(doc.provenance.upstreamIds, {
      accessionNumber: filing.accessionNumber,
      cik: filing.cik,
    });
    assert.equal(doc.provenance.authorityScore, 1);
    assert.deepEqual(doc.metadata, {
      form: "10-Q",
      ticker: "AAPL",
      isXbrl: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production ports map Tavily live results through HybridDocumentPorts.live", async () => {
  const entity = appleEntity();
  const liveUrl = "https://live.example.com/aapl-update";
  let tavilyCalls = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;

  try {
    const ports = await createProductionHybridDocumentPorts(
      baseInput({
        sources: {
          astra: async () => [],
          filings: async () => [],
          tavily: async (query) => {
            tavilyCalls += 1;
            assert.equal(query.provider, "tavily");
            assert.equal(query.query, "latest Apple headlines");
            assert.deepEqual(query.entityIds, [entity.id]);
            assert.deepEqual(query.tickers, ["AAPL"]);
            return [
              {
                kind: "tavily",
                title: "Apple shares react to product news",
                outlet: "Live Wire",
                url: liveUrl,
                excerpt: "Traders digested the latest Apple product cycle update.",
                score: 0.77,
                retrievedAt: "2026-08-09T11:30:00.000Z",
              } satisfies EvidenceInput,
            ];
          },
        },
      })
    );

    assert.ok(ports.live, "live search port should be present");
    const hits = await ports.live.search({
      queryId: "live-q",
      text: "latest Apple headlines",
      limit: 5,
      filter: { kinds: ["web", "news"] },
    });

    assert.equal(tavilyCalls, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.channel, "live");
    assert.equal(hit.provider, "tavily");
    assert.equal(hit.rank, 1);
    assert.equal(hit.score, 0.77);
    assert.equal(hit.liveScore, 0.77);
    assert.equal(hit.document.kind, "news");
    assert.equal(hit.document.documentId, `tavily:${digest(liveUrl)}`);
    assert.equal(hit.document.title, "Apple shares react to product news");
    assert.deepEqual(hit.document.issuerIds, [entity.id]);
    assert.deepEqual(hit.document.instrumentIds, [entity.id]);
    assert.equal(hit.document.provenance.provider, "tavily");
    assert.equal(hit.document.provenance.sourceUrl, liveUrl);
    assert.equal(hit.document.provenance.authorityScore, 0.77);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production ports drop invalid URLs from Astra archive and Tavily live", async () => {
  const entity = appleEntity();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;

  try {
    const ports = await createProductionHybridDocumentPorts(
      baseInput({
        sources: {
          astra: async () => [
            {
              kind: "astra",
              title: "Bad Astra URL",
              outlet: "Wire",
              url: "javascript:alert(1)",
              excerpt: "Should be dropped.",
            },
            {
              kind: "astra",
              title: "Localhost Astra URL",
              outlet: "Wire",
              url: "http://localhost/news",
              excerpt: "Should be dropped.",
            },
            {
              kind: "astra",
              title: "Valid Astra article",
              outlet: "Wire",
              url: "https://news.example.com/valid-astra",
              excerpt: "Kept archive row.",
              entityIds: [entity.id],
            },
          ],
          filings: async () => [],
          tavily: async () => [
            {
              kind: "tavily",
              title: "Bad Tavily URL",
              outlet: "Web",
              url: "not a url",
              excerpt: "Should be dropped.",
            },
            {
              kind: "tavily",
              title: "Private IP Tavily URL",
              outlet: "Web",
              url: "http://192.168.1.10/story",
              excerpt: "Should be dropped.",
            },
            {
              kind: "tavily",
              title: "Valid Tavily article",
              outlet: "Web",
              url: "https://live.example.com/valid-tavily",
              excerpt: "Kept live row.",
            },
          ],
        },
      })
    );

    const archive = await ports.store.list({ kinds: ["news"] });
    assert.equal(archive.length, 1);
    assert.equal(archive[0]?.title, "Valid Astra article");
    assert.equal(
      archive[0]?.documentId,
      `astra:${digest("https://news.example.com/valid-astra")}`
    );

    const liveHits = await ports.live!.search({
      queryId: "invalid-url-live",
      text: "Apple",
      limit: 10,
    });
    assert.equal(liveHits.length, 1);
    assert.equal(liveHits[0]?.document.title, "Valid Tavily article");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production ports never call fetch when all sources are injected", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;

  try {
    const ports = await createProductionHybridDocumentPorts(
      baseInput({
        entities: [
          appleEntity(),
          {
            id: "issuer:cba",
            name: "Commonwealth Bank",
            query: "CBA",
            ticker: "CBA",
            market: "au",
          },
          {
            id: "issuer:private-co",
            name: "Private Co",
            query: "Private",
            ticker: "PRIV",
            market: "us",
            private: true,
          },
        ],
        sources: {
          astra: async () => [
            {
              kind: "astra",
              title: "Archive headline",
              outlet: "Wire",
              url: "https://news.example.com/archive",
              excerpt: "Archive body.",
            },
          ],
          filings: async (ticker) => {
            assert.equal(ticker, "AAPL");
            return [filingFixture()];
          },
          tavily: async () => [
            {
              kind: "tavily",
              title: "Live headline",
              outlet: "Web",
              url: "https://live.example.com/live",
              excerpt: "Live body.",
              score: 0.5,
            },
          ],
        },
      })
    );

    const all = await ports.store.list();
    assert.equal(all.length, 2);
    assert.ok(all.some((doc) => doc.kind === "news"));
    assert.ok(all.some((doc) => doc.kind === "filing"));

    const liveHits = await ports.live!.search({
      queryId: "no-network",
      text: "Apple",
      limit: 3,
    });
    assert.equal(liveHits.length, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

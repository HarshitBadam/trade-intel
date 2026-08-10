import "server-only";

import { createHash } from "node:crypto";
import { getSecFilingsForTicker } from "@/lib/market-data/sec-edgar";
import { safeSourceUrl, type EvidenceInput } from "../../citations";
import { retrieveAstra } from "../../evidence/astra";
import { searchTavily } from "../../tavily";
import type { EvidenceQuery, FinanceEntity } from "../../types";
import { InMemoryBm25LexicalIndex } from "./bm25";
import type { LiveSearch } from "./ports";
import { HeuristicReranker } from "./reranker";
import type { HybridDocumentPorts } from "./retrieval";
import { InMemoryDocumentStore } from "./store";
import type {
  DocumentKind,
  NormalizedDocument,
  RetrievalHit,
  RetrievalQuery,
} from "./types";

export type ProductionDocumentPortsInput = {
  queryId: string;
  query: string;
  entities: readonly FinanceEntity[];
  kinds: readonly DocumentKind[];
  intervals?: readonly { startSession: string; endSession: string }[];
  limit?: number;
  now?: Date;
  sources?: {
    astra?: typeof retrieveAstra;
    tavily?: typeof searchTavily;
    filings?: typeof getSecFilingsForTicker;
  };
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function timestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function freshnessDays(
  intervals: ProductionDocumentPortsInput["intervals"],
  now: Date
): number | undefined {
  const earliest = intervals
    ?.map((interval) => interval.startSession)
    .sort()[0];
  if (!earliest) return 90;
  const start = Date.parse(`${earliest}T00:00:00.000Z`);
  if (!Number.isFinite(start)) return 90;
  return Math.max(1, Math.ceil((now.getTime() - start) / 86_400_000) + 2);
}

function evidenceKind(
  input: EvidenceInput,
  allowed: readonly DocumentKind[]
): DocumentKind {
  if (input.kind === "astra") return "news";
  if (allowed.includes("news")) return "news";
  if (allowed.includes("research")) return "research";
  if (allowed.includes("transcript")) return "transcript";
  return "web";
}

function normalizeEntityAlias(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function includesEntityAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizeEntityAlias(alias);
  if (normalizedAlias.length < 3) return false;
  return ` ${normalizeEntityAlias(text)} `.includes(` ${normalizedAlias} `);
}

function includesTicker(text: string, ticker: string): boolean {
  const value = ticker.trim();
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    value.length > 2 ? "iu" : "u"
  ).test(text);
}

function evidenceMetadataText(input: EvidenceInput): string {
  return [
    input.ticker,
    input.event,
    input.importance,
    input.keyObservations,
    input.sentiment,
    input.sentimentReasoning,
    ...(input.criteria ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function confirmedEntityIds(
  input: EvidenceInput,
  entities: readonly FinanceEntity[]
): string[] {
  const providerIds = new Set(
    (input.entityIds ?? []).map(normalizeEntityAlias).filter(Boolean)
  );
  const metadataText = evidenceMetadataText(input);
  const searchableText = `${input.title} ${input.excerpt} ${metadataText}`;

  return entities.flatMap((entity): string[] => {
    const identifiers = [entity.id, entity.ticker, entity.name, entity.query]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeEntityAlias);
    const providerConfirmed = identifiers.some((id) => providerIds.has(id));
    const tickerConfirmed =
      Boolean(entity.ticker) &&
      (normalizeEntityAlias(input.ticker ?? "") ===
        normalizeEntityAlias(entity.ticker ?? "") ||
        includesTicker(searchableText, entity.ticker ?? ""));
    const nameConfirmed = [entity.name, entity.query].some((alias) =>
      includesEntityAlias(searchableText, alias)
    );
    return providerConfirmed || tickerConfirmed || nameConfirmed
      ? [entity.id]
      : [];
  });
}

function evidenceDocument(
  input: EvidenceInput,
  allowedKinds: readonly DocumentKind[],
  entities: readonly FinanceEntity[],
  now: Date
): NormalizedDocument | null {
  const url = safeSourceUrl(input.url);
  const title = input.title.trim();
  const excerpt = input.excerpt.trim();
  if (!url || !title || !excerpt) return null;
  const fetchedAt = timestamp(input.retrievedAt, now.toISOString());
  const publishedAt = input.publishedAt
    ? timestamp(input.publishedAt, fetchedAt)
    : undefined;
  const entityIds = confirmedEntityIds(input, entities);
  return {
    documentId: `${input.kind}:${digest(url)}`,
    kind: evidenceKind(input, allowedKinds),
    title,
    content: excerpt,
    excerpt,
    issuerIds: entityIds,
    instrumentIds: entityIds,
    ...(publishedAt ? { publishedAt, eventAt: publishedAt } : {}),
    fetchedAt,
    contentVersion: digest(
      `${title}\u0000${excerpt}\u0000${publishedAt ?? ""}`
    ),
    provenance: {
      provider: input.kind,
      sourceId: input.outlet || input.kind,
      sourceUrl: url,
      canonicalUrl: url,
      publisher: input.outlet || undefined,
      fetchedBy: input.kind,
      ...(typeof input.score === "number"
        ? { authorityScore: Math.max(0, Math.min(1, input.score)) }
        : {}),
    },
    metadata: {
      ...(input.ticker ? { ticker: input.ticker } : {}),
      ...(input.event ? { event: input.event } : {}),
      ...(input.importance ? { importance: input.importance } : {}),
      ...(input.sentiment ? { sentiment: input.sentiment } : {}),
    },
  };
}

function evidenceQuery(
  input: ProductionDocumentPortsInput,
  provider: "astra" | "tavily",
  limit: number
): EvidenceQuery {
  return {
    id: `${input.queryId}:${provider}`,
    provider,
    query: input.query,
    entityIds: input.entities.map((entity) => entity.id),
    tickers: input.entities.flatMap((entity) =>
      entity.ticker ? [entity.ticker] : []
    ),
    criteria: [],
    freshnessDays: freshnessDays(input.intervals, input.now ?? new Date()),
    topic: "news",
    limit,
  };
}

function liveSearch(
  input: ProductionDocumentPortsInput
): LiveSearch {
  return {
    async search(query: RetrievalQuery): Promise<readonly RetrievalHit[]> {
      const raw = await (input.sources?.tavily ?? searchTavily)(
        evidenceQuery(
          {
            ...input,
            queryId: query.queryId,
            query: query.text,
            kinds: query.filter?.kinds ?? input.kinds,
          },
          "tavily",
          query.limit ?? input.limit ?? 10
        )
      );
      const now = input.now ?? new Date();
      return raw.flatMap((item, index): RetrievalHit[] => {
        const document = evidenceDocument(
          item,
          query.filter?.kinds ?? input.kinds,
          input.entities,
          now
        );
        if (!document) return [];
        const score =
          typeof item.score === "number"
            ? Math.max(0, Math.min(1, item.score))
            : 1 / (index + 1);
        return [
          {
            document,
            channel: "live",
            score,
            rank: index + 1,
            provider: "tavily",
            liveScore: score,
          },
        ];
      });
    },
  };
}

async function filingDocuments(
  input: ProductionDocumentPortsInput
): Promise<NormalizedDocument[]> {
  if (!input.kinds.includes("filing")) return [];
  const now = input.now ?? new Date();
  const rows = await Promise.all(
    input.entities
      .filter(
        (entity) =>
          entity.market === "us" && Boolean(entity.ticker) && !entity.private
      )
      .map(async (entity) => {
        try {
          const filings = await (
            input.sources?.filings ?? getSecFilingsForTicker
          )(entity.ticker as string, {
            limit: 12,
            ...(input.intervals?.length
              ? {
                  filedFrom: input.intervals
                    .map((interval) => interval.startSession)
                    .sort()[0],
                  filedTo: input.intervals
                    .map((interval) => interval.endSession)
                    .sort()
                    .at(-1),
                }
              : {}),
          });
          return filings.map((filing): NormalizedDocument => {
            const sourceUrl = filing.documentUrl ?? filing.url;
            const filedAt = timestamp(filing.filedAt, now.toISOString());
            const title = `${entity.name} ${filing.form} filing`;
            const excerpt = [
              filing.primaryDocumentDescription,
              filing.items ? `Items: ${filing.items}.` : undefined,
              filing.periodOfReport
                ? `Reporting period: ${filing.periodOfReport}.`
                : undefined,
              `Filed ${filing.filedAt}.`,
            ]
              .filter(Boolean)
              .join(" ");
            return {
              documentId: `sec:${filing.accessionNumber}`,
              kind: "filing",
              title,
              content: excerpt,
              excerpt,
              issuerIds: [entity.id],
              instrumentIds: [entity.id],
              eventAt: filing.periodOfReport
                ? timestamp(filing.periodOfReport, filedAt)
                : filedAt,
              publishedAt: filedAt,
              fetchedAt: timestamp(
                filing.provenance.fetchedAt,
                now.toISOString()
              ),
              contentVersion: digest(
                `${filing.accessionNumber}:${filing.filedAt}:${excerpt}`
              ),
              provenance: {
                provider: "sec_edgar",
                sourceId: "SEC EDGAR",
                sourceUrl,
                canonicalUrl: filing.url,
                publisher: "U.S. Securities and Exchange Commission",
                upstreamIds: {
                  accessionNumber: filing.accessionNumber,
                  cik: filing.cik,
                },
                authorityScore: 1,
              },
              metadata: {
                form: filing.form,
                ticker: entity.ticker as string,
                isXbrl: filing.isXbrl ?? false,
              },
            };
          });
        } catch {
          return [];
        }
      })
  );
  return rows.flat();
}

/**
 * Read-through production adapter: hydrate the request-scoped archive from the
 * existing committed Astra/SEC paths, then use the greenfield hybrid pipeline.
 * A durable collection can replace this store without changing retrieval.
 */
export async function createProductionHybridDocumentPorts(
  input: ProductionDocumentPortsInput
): Promise<HybridDocumentPorts> {
  const store = new InMemoryDocumentStore();
  const now = input.now ?? new Date();
  const [astra, filings] = await Promise.all([
    (input.sources?.astra ?? retrieveAstra)(
      evidenceQuery(input, "astra", input.limit ?? 16),
      [...input.entities]
    ).catch(() => []),
    filingDocuments(input),
  ]);
  const archive = astra.flatMap((item): NormalizedDocument[] => {
    const document = evidenceDocument(
      item,
      input.kinds,
      input.entities,
      now
    );
    return document ? [document] : [];
  });
  await store.putMany([...archive, ...filings]);
  return {
    store,
    lexical: new InMemoryBm25LexicalIndex(),
    live: liveSearch(input),
    reranker: new HeuristicReranker(),
  };
}

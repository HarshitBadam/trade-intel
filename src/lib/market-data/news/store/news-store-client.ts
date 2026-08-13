import "server-only";

import {
  DataAPIClient,
  type Collection,
  type Db,
} from "@datastax/astra-db-ts";
import {
  ASTRA_DB_ANALYSIS_COLLECTION,
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NEWS_COLLECTION,
} from "@/lib/config";
import type { AnalysisDoc, StoredArticle } from "../../types";

export type AnalysisMode = "separate" | "fallback";

const ANALYSIS_DOC_TYPE = "ticker_analysis";

let db: Db | null = null;
let analysisMode: AnalysisMode | null = null;

export function astraDb(): Db {
  if (!db) {
    db = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!).db(ASTRA_DB_API_ENDPOINT!);
  }
  return db;
}

export function newsCollection(): Collection<StoredArticle> {
  return astraDb().collection<StoredArticle>(ASTRA_DB_NEWS_COLLECTION);
}

export async function listNewsStoreCollections(): Promise<string[]> {
  return astraDb().listCollections({ nameOnly: true });
}

// Verdicts are keyed documents, so the preferred collection is non-vector.
// If Astra's collection cap blocks creation, namespacing keeps fallback verdict
// rows out of article queries in the shared news collection.
export async function ensureAnalysisCollection(): Promise<AnalysisMode> {
  if (analysisMode) return analysisMode;
  const existing = await listNewsStoreCollections().catch(() => [] as string[]);
  if (existing.includes(ASTRA_DB_ANALYSIS_COLLECTION)) {
    analysisMode = "separate";
    return analysisMode;
  }
  try {
    await astraDb().createCollection(ASTRA_DB_ANALYSIS_COLLECTION, {
      checkExists: false,
    });
    analysisMode = "separate";
  } catch (error) {
    const current = await listNewsStoreCollections().catch(() => [] as string[]);
    if (current.includes(ASTRA_DB_ANALYSIS_COLLECTION)) {
      analysisMode = "separate";
    } else {
      console.error(
        `[news-store] could not create ${ASTRA_DB_ANALYSIS_COLLECTION} ` +
          `(likely the free-tier collection cap); co-locating verdicts in ` +
          `${ASTRA_DB_NEWS_COLLECTION} under doc_type="${ANALYSIS_DOC_TYPE}":`,
        error
      );
      analysisMode = "fallback";
    }
  }
  return analysisMode;
}

export async function analysisRef(ticker: string): Promise<{
  collection: Collection<AnalysisDoc>;
  id: string;
  onInsert: Partial<AnalysisDoc> & Record<string, unknown>;
}> {
  const mode = await ensureAnalysisCollection();
  const symbol = ticker.trim().toUpperCase();
  if (mode === "separate") {
    return {
      collection: astraDb().collection<AnalysisDoc>(ASTRA_DB_ANALYSIS_COLLECTION),
      id: symbol,
      onInsert: { ticker: symbol },
    };
  }
  return {
    collection: newsCollection() as unknown as Collection<AnalysisDoc>,
    id: `analysis_${symbol}`,
    onInsert: { ticker: symbol, doc_type: ANALYSIS_DOC_TYPE },
  };
}
